// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Dharma — Karuna's onchain rulebook (CLAUDE.md §1, §2)
/// @notice Holds an organization's policy: rules, core boundaries, payees, agent allowances,
///         allowlisted domains, the two-person threshold, members, and the freeze switch.
///         - Tightening is fast: one member's signature (or the Gatekeeper, which can only tighten).
///         - Loosening is slow and public: a member proposes, a majority votes, a timelock passes.
///         - Core boundaries can never be removed.
///         - The contract decides what counts as tightening; callers can't relabel a loosening.
///         Members sign EIP-712 actions with their own keys. The Gatekeeper only relays them and
///         pays gas — it cannot forge a member's vote.
contract Dharma {
    // ------------------------------------------------------------------ types

    enum Op {
        AddRule, RemoveRule, SetPayee, RemovePayee, SetAgent, RemoveAgent,
        AddDomain, RemoveDomain, SetThreshold, Freeze, Unfreeze, AddMember, RemoveMember
    }
    enum Outcome { Allow, Deny, Approval }
    enum Status { None, Open, Queued, Executed, Defeated }
    enum Kind { Tighten, Propose, Vote }

    struct Rule {
        bytes32 id;
        Outcome outcome;
        bool core; // can never be removed
        bool builtin; // one of Karuna's default rules (logic lives in the policy engine)
        bool active;
        bytes32 agent; // 0 = every agent
        string scope; // custom rules: "payment", "payment:<category>", "http"
        string target; // custom rules: payee address or domain ("" = any)
        uint256 maxMicroUsd; // custom allow rules: upper bound (0 = none)
    }

    struct Payee {
        address account;
        string category;
    }

    struct Proposal {
        Op op;
        bytes data;
        address proposer;
        uint64 createdAt;
        uint64 queuedAt;
        uint32 yes;
        uint32 no;
        Status status;
    }

    // ------------------------------------------------------------------ events

    event RuleAdded(bytes32 indexed id, Outcome outcome, bytes32 agent, string scope, string target, uint256 maxMicroUsd);
    event RuleRemoved(bytes32 indexed id);
    event PayeeSet(address indexed account, string category);
    event PayeeRemoved(address indexed account);
    event AgentSet(bytes32 indexed agent, uint256 capMicroUsd);
    event AgentRemoved(bytes32 indexed agent);
    event DomainAdded(string domain);
    event DomainRemoved(string domain);
    event ThresholdSet(uint256 microUsd);
    event AgentFrozen(address indexed by);
    event AgentsUnfrozen();
    event MemberAdded(address indexed member);
    event MemberRemoved(address indexed member);
    event Tightened(Op op, address indexed by);
    event ProposalCreated(uint256 indexed id, Op op, address indexed proposer, bytes data);
    event VoteCast(uint256 indexed id, address indexed voter, bool support, uint32 yes, uint32 no);
    event ProposalQueued(uint256 indexed id, uint64 eta);
    event ProposalExecuted(uint256 indexed id);
    event ProposalDefeated(uint256 indexed id);
    event LogAnchored(bytes32 head, uint64 length);
    event ApprovalRequested(bytes32 indexed requestId, bytes32 indexed agent, uint256 amountMicroUsd, bytes32 payloadHash);
    event TestFailed(bytes32 indexed agent, string category);

    // ------------------------------------------------------------------ errors

    error NotGatekeeper();
    error NotMember();
    error BadSignature();
    error Expired();
    error NotTightening();
    error UseTighten();
    error CoreBoundary();
    error Invalid(string why);
    error NotReady();

    // ------------------------------------------------------------------ storage

    address public immutable gatekeeper;
    uint64 public immutable timelock;
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant ACTION_TYPEHASH = keccak256(
        "Action(uint8 kind,uint8 op,bytes data,uint256 proposalId,bool support,uint256 nonce,uint256 deadline)"
    );

    bool public frozen;
    uint256 public thresholdMicroUsd;
    uint256 public policyVersion; // bumps on every policy change; cheap staleness check
    bytes32 public logHead;
    uint64 public logLength;

    address[] internal _members;
    mapping(address => uint256) internal _memberIdx; // index + 1
    mapping(address => uint256) public nonces;

    bytes32[] internal _ruleIds;
    mapping(bytes32 => Rule) internal _rules;
    mapping(bytes32 => bool) internal _ruleKnown;

    address[] internal _payeeAddrs;
    mapping(address => uint256) internal _payeeIdx;
    mapping(address => string) internal _payeeCategory;

    bytes32[] internal _agentIds;
    mapping(bytes32 => uint256) internal _agentIdx;
    mapping(bytes32 => uint256) public agentCap;

    string[] internal _domains;
    mapping(bytes32 => uint256) internal _domainIdx;

    Proposal[] internal _proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    // ------------------------------------------------------------------ setup

    /// @param gatekeeper_ the org's Gatekeeper (relayer; may only tighten, anchor, and emit alerts)
    /// @param firstMember the first human's signing address (constructor args, because a smart
    ///        account deploys through a factory and msg.sender is not the org)
    constructor(address gatekeeper_, address firstMember, uint64 timelock_, uint256 thresholdMicroUsd_, string[] memory domains_) {
        if (gatekeeper_ == address(0) || firstMember == address(0)) revert Invalid("zero address");
        gatekeeper = gatekeeper_;
        timelock = timelock_;
        thresholdMicroUsd = thresholdMicroUsd_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Dharma"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        _addMember(firstMember);
        for (uint256 i; i < domains_.length; i++) _addDomain(domains_[i]);

        // Karuna's default policy, in engine order. Core boundaries can never be removed.
        _builtin("core-boundary", Outcome.Deny, true);
        _builtin("secrets-read", Outcome.Deny, true);
        _builtin("unknown-recipient", Outcome.Deny, true);
        _builtin("payment-within-allowance", Outcome.Allow, false);
        _builtin("payment-approval", Outcome.Approval, false);
        _builtin("destructive-shell", Outcome.Approval, false);
        _builtin("package-install", Outcome.Approval, false);
        _builtin("human-approval-writes", Outcome.Approval, false);
        _builtin("allowlisted-domain", Outcome.Allow, false);
        _builtin("http-mutations", Outcome.Approval, false);
        _builtin("unlisted-domain", Outcome.Deny, false);
        _builtin("workspace-read", Outcome.Allow, false);
        _builtin("default-deny", Outcome.Deny, true);
    }

    function _builtin(bytes32 id, Outcome outcome, bool core) private {
        _rules[id] = Rule(id, outcome, core, true, true, bytes32(0), "", "", 0);
        _ruleKnown[id] = true;
        _ruleIds.push(id);
    }

    // ------------------------------------------------------------------ member actions

    /// @notice Apply a tightening right away. Signed by a member — or sent by the Gatekeeper with
    ///         signer = 0 (Auto-Shield, Swarm Stopper), which can therefore only ever tighten.
    function tighten(Op op, bytes calldata data, address signer, uint256 deadline, bytes calldata sig) external {
        address actor;
        if (signer == address(0)) {
            if (msg.sender != gatekeeper) revert NotGatekeeper();
            actor = gatekeeper;
        } else {
            _auth(Kind.Tighten, op, data, 0, false, signer, deadline, sig);
            actor = signer;
        }
        if (!isTightening(op, data)) revert NotTightening();
        _validate(op, data);
        _apply(op, data, actor);
        emit Tightened(op, actor);
    }

    /// @notice Propose a loosening. The proposer's signature also counts as their "yes" vote.
    function propose(Op op, bytes calldata data, address signer, uint256 deadline, bytes calldata sig) external returns (uint256 id) {
        _auth(Kind.Propose, op, data, 0, false, signer, deadline, sig);
        if (isTightening(op, data)) revert UseTighten();
        _validate(op, data);
        id = _proposals.length;
        _proposals.push(Proposal(op, data, signer, uint64(block.timestamp), 0, 0, 0, Status.Open));
        emit ProposalCreated(id, op, signer, data);
        _count(id, signer, true);
    }

    function vote(uint256 id, bool support, address signer, uint256 deadline, bytes calldata sig) external {
        if (id >= _proposals.length) revert Invalid("no such proposal");
        Proposal storage p = _proposals[id];
        _auth(Kind.Vote, p.op, p.data, id, support, signer, deadline, sig);
        if (p.status != Status.Open) revert Invalid("voting closed");
        if (hasVoted[id][signer]) revert Invalid("already voted");
        _count(id, signer, support);
    }

    /// @notice Anyone may execute a passed proposal once its timelock has elapsed.
    function execute(uint256 id) external {
        if (id >= _proposals.length) revert Invalid("no such proposal");
        Proposal storage p = _proposals[id];
        if (p.status != Status.Queued || block.timestamp < uint256(p.queuedAt) + timelock) revert NotReady();
        _validate(p.op, p.data); // re-check: e.g. a core boundary is still never removable
        p.status = Status.Executed;
        _apply(p.op, p.data, p.proposer);
        emit ProposalExecuted(id);
    }

    function required() public view returns (uint32) {
        return uint32(_members.length / 2 + 1);
    }

    function _count(uint256 id, address voter, bool support) private {
        Proposal storage p = _proposals[id];
        hasVoted[id][voter] = true;
        if (support) p.yes++;
        else p.no++;
        emit VoteCast(id, voter, support, p.yes, p.no);
        uint32 need = required();
        if (p.yes >= need) {
            p.status = Status.Queued;
            p.queuedAt = uint64(block.timestamp);
            emit ProposalQueued(id, uint64(block.timestamp) + timelock);
        } else if (p.no > _members.length - need) {
            p.status = Status.Defeated;
            emit ProposalDefeated(id);
        }
    }

    // ------------------------------------------------------------------ gatekeeper-only

    /// @notice Anchor the signed decision log. Length can only grow, so history can't be rewound.
    function anchorLog(bytes32 head, uint64 length) external {
        if (msg.sender != gatekeeper) revert NotGatekeeper();
        if (length < logLength) revert Invalid("log cannot shrink");
        logHead = head;
        logLength = length;
        emit LogAnchored(head, length);
    }

    /// @notice Public signal that a payment is waiting for a human (streamed by QuickNode).
    function requestApproval(bytes32 requestId, bytes32 agent, uint256 amountMicroUsd, bytes32 payloadHash) external {
        if (msg.sender != gatekeeper) revert NotGatekeeper();
        emit ApprovalRequested(requestId, agent, amountMicroUsd, payloadHash);
    }

    /// @notice Public record that an agent failed an Auto-Shield test (Phase 5).
    function reportTestFailed(bytes32 agent, string calldata category) external {
        if (msg.sender != gatekeeper) revert NotGatekeeper();
        emit TestFailed(agent, category);
    }

    // ------------------------------------------------------------------ classification

    /// @notice True when applying this change can only make the policy stricter.
    function isTightening(Op op, bytes memory data) public view returns (bool) {
        if (op == Op.AddRule) {
            (bytes32 id, uint8 outcome,,,,) = abi.decode(data, (bytes32, uint8, bytes32, string, string, uint256));
            Outcome o = _ruleKnown[id] && _rules[id].builtin ? _rules[id].outcome : Outcome(outcome);
            return o != Outcome.Allow;
        }
        if (op == Op.RemoveRule) {
            bytes32 id = abi.decode(data, (bytes32));
            return _ruleKnown[id] && _rules[id].outcome == Outcome.Allow; // dropping an allow is stricter
        }
        if (op == Op.SetAgent) {
            (bytes32 id, uint256 cap) = abi.decode(data, (bytes32, uint256));
            return _agentIdx[id] != 0 && cap <= agentCap[id];
        }
        if (op == Op.SetThreshold) return abi.decode(data, (uint256)) <= thresholdMicroUsd;
        return op == Op.RemovePayee || op == Op.RemoveAgent || op == Op.RemoveDomain || op == Op.Freeze;
        // SetPayee, AddDomain, Unfreeze, AddMember, RemoveMember are always loosenings.
    }

    // ------------------------------------------------------------------ validation + effects

    function _validate(Op op, bytes memory data) private view {
        if (op == Op.AddRule) {
            (bytes32 id, uint8 outcome,,,,) = abi.decode(data, (bytes32, uint8, bytes32, string, string, uint256));
            if (id == bytes32(0) || outcome > uint8(Outcome.Approval)) revert Invalid("bad rule");
            if (_ruleKnown[id] && _rules[id].active) revert Invalid("rule exists");
        } else if (op == Op.RemoveRule) {
            bytes32 id = abi.decode(data, (bytes32));
            if (!_ruleKnown[id] || !_rules[id].active) revert Invalid("no such rule");
            if (_rules[id].core) revert CoreBoundary();
        } else if (op == Op.SetPayee) {
            (address a,) = abi.decode(data, (address, string));
            if (a == address(0)) revert Invalid("zero address");
        } else if (op == Op.RemovePayee) {
            if (_payeeIdx[abi.decode(data, (address))] == 0) revert Invalid("no such payee");
        } else if (op == Op.SetAgent) {
            (bytes32 id,) = abi.decode(data, (bytes32, uint256));
            if (id == bytes32(0)) revert Invalid("bad agent");
        } else if (op == Op.RemoveAgent) {
            if (_agentIdx[abi.decode(data, (bytes32))] == 0) revert Invalid("no such agent");
        } else if (op == Op.AddDomain) {
            string memory d = abi.decode(data, (string));
            if (bytes(d).length == 0 || _domainIdx[keccak256(bytes(d))] != 0) revert Invalid("bad domain");
        } else if (op == Op.RemoveDomain) {
            if (_domainIdx[keccak256(bytes(abi.decode(data, (string))))] == 0) revert Invalid("no such domain");
        } else if (op == Op.Freeze) {
            if (frozen) revert Invalid("already frozen");
        } else if (op == Op.Unfreeze) {
            if (!frozen) revert Invalid("not frozen");
        } else if (op == Op.AddMember) {
            address m = abi.decode(data, (address));
            if (m == address(0) || _memberIdx[m] != 0) revert Invalid("bad member");
        } else if (op == Op.RemoveMember) {
            address m = abi.decode(data, (address));
            if (_memberIdx[m] == 0 || _members.length == 1) revert Invalid("cannot remove");
        }
    }

    function _apply(Op op, bytes memory data, address actor) private {
        policyVersion++;
        if (op == Op.AddRule) {
            (bytes32 id, uint8 outcome, bytes32 agent, string memory scope, string memory target, uint256 maxMicroUsd) =
                abi.decode(data, (bytes32, uint8, bytes32, string, string, uint256));
            if (_ruleKnown[id] && _rules[id].builtin) {
                _rules[id].active = true; // re-enable a default rule with its original meaning
                Rule storage b = _rules[id];
                emit RuleAdded(id, b.outcome, bytes32(0), "", "", 0);
                return;
            }
            if (!_ruleKnown[id]) {
                _ruleKnown[id] = true;
                _ruleIds.push(id);
            }
            _rules[id] = Rule(id, Outcome(outcome), false, false, true, agent, scope, target, maxMicroUsd);
            emit RuleAdded(id, Outcome(outcome), agent, scope, target, maxMicroUsd);
        } else if (op == Op.RemoveRule) {
            bytes32 id = abi.decode(data, (bytes32));
            _rules[id].active = false;
            emit RuleRemoved(id);
        } else if (op == Op.SetPayee) {
            (address a, string memory category) = abi.decode(data, (address, string));
            if (_payeeIdx[a] == 0) {
                _payeeAddrs.push(a);
                _payeeIdx[a] = _payeeAddrs.length;
            }
            _payeeCategory[a] = category;
            emit PayeeSet(a, category);
        } else if (op == Op.RemovePayee) {
            address a = abi.decode(data, (address));
            _removeAddr(_payeeAddrs, _payeeIdx, a);
            delete _payeeCategory[a];
            emit PayeeRemoved(a);
        } else if (op == Op.SetAgent) {
            (bytes32 id, uint256 cap) = abi.decode(data, (bytes32, uint256));
            if (_agentIdx[id] == 0) {
                _agentIds.push(id);
                _agentIdx[id] = _agentIds.length;
            }
            agentCap[id] = cap;
            emit AgentSet(id, cap);
        } else if (op == Op.RemoveAgent) {
            bytes32 id = abi.decode(data, (bytes32));
            uint256 i = _agentIdx[id] - 1;
            bytes32 last = _agentIds[_agentIds.length - 1];
            _agentIds[i] = last;
            _agentIdx[last] = i + 1;
            _agentIds.pop();
            delete _agentIdx[id];
            delete agentCap[id];
            emit AgentRemoved(id);
        } else if (op == Op.AddDomain) {
            _addDomain(abi.decode(data, (string)));
        } else if (op == Op.RemoveDomain) {
            string memory d = abi.decode(data, (string));
            bytes32 k = keccak256(bytes(d));
            uint256 i = _domainIdx[k] - 1;
            string memory last = _domains[_domains.length - 1];
            _domains[i] = last;
            _domainIdx[keccak256(bytes(last))] = i + 1;
            _domains.pop();
            delete _domainIdx[k];
            emit DomainRemoved(d);
        } else if (op == Op.SetThreshold) {
            thresholdMicroUsd = abi.decode(data, (uint256));
            emit ThresholdSet(thresholdMicroUsd);
        } else if (op == Op.Freeze) {
            frozen = true;
            emit AgentFrozen(actor);
        } else if (op == Op.Unfreeze) {
            frozen = false;
            emit AgentsUnfrozen();
        } else if (op == Op.AddMember) {
            _addMember(abi.decode(data, (address)));
        } else if (op == Op.RemoveMember) {
            address m = abi.decode(data, (address));
            _removeAddr(_members, _memberIdx, m);
            emit MemberRemoved(m);
        }
    }

    function _addMember(address m) private {
        _members.push(m);
        _memberIdx[m] = _members.length;
        emit MemberAdded(m);
    }

    function _addDomain(string memory d) private {
        _domains.push(d);
        _domainIdx[keccak256(bytes(d))] = _domains.length;
        emit DomainAdded(d);
    }

    function _removeAddr(address[] storage list, mapping(address => uint256) storage idx, address a) private {
        uint256 i = idx[a] - 1;
        address last = list[list.length - 1];
        list[i] = last;
        idx[last] = i + 1;
        list.pop();
        delete idx[a];
    }

    // ------------------------------------------------------------------ signatures

    function actionDigest(Kind kind, Op op, bytes memory data, uint256 proposalId, bool support, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(ACTION_TYPEHASH, uint8(kind), uint8(op), keccak256(data), proposalId, support, nonce, deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _auth(Kind kind, Op op, bytes memory data, uint256 proposalId, bool support, address signer, uint256 deadline, bytes calldata sig)
        private
    {
        if (block.timestamp > deadline) revert Expired();
        if (_memberIdx[signer] == 0) revert NotMember();
        bytes32 digest = actionDigest(kind, op, data, proposalId, support, nonces[signer], deadline);
        if (_recover(digest, sig) != signer) revert BadSignature();
        nonces[signer]++;
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        // reject malleable signatures (EIP-2)
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }

    // ------------------------------------------------------------------ views

    function members() external view returns (address[] memory) {
        return _members;
    }

    function isMember(address a) external view returns (bool) {
        return _memberIdx[a] != 0;
    }

    function rules() external view returns (Rule[] memory out) {
        out = new Rule[](_ruleIds.length);
        for (uint256 i; i < _ruleIds.length; i++) out[i] = _rules[_ruleIds[i]];
    }

    function payees() external view returns (Payee[] memory out) {
        out = new Payee[](_payeeAddrs.length);
        for (uint256 i; i < _payeeAddrs.length; i++) out[i] = Payee(_payeeAddrs[i], _payeeCategory[_payeeAddrs[i]]);
    }

    function agents() external view returns (bytes32[] memory ids, uint256[] memory caps) {
        ids = _agentIds;
        caps = new uint256[](ids.length);
        for (uint256 i; i < ids.length; i++) caps[i] = agentCap[ids[i]];
    }

    function domains() external view returns (string[] memory) {
        return _domains;
    }

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    function proposal(uint256 id) external view returns (Proposal memory) {
        return _proposals[id];
    }
}
