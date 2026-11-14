// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Dharma — Karuna's onchain rulebook (CLAUDE.md §1, §2)
/// @notice Holds an organization's policy: rules, core boundaries, payees, agent allowances,
///         allowlisted domains, the two-person threshold, members, the freeze switch, and the waits.
///         Two tiers of change:
///         - Normal changes: proposed, passed by a majority, applied after the wait (`timelock`).
///           If every member votes yes (2+ members), the wait is skipped — except for Unfreeze.
///         - Core changes (removing a core rule, the core wait itself, upgrading this code): need every
///           member, always wait `coreTimelock`, can't be skipped, and any member's Freeze cancels them.
///         Only two things are instant: a member's Freeze, and the Gatekeeper's own tighten-only writes.
///         A changed wait applies to proposals that pass after it, never to ones already waiting.
///         Members sign EIP-712 actions with their own keys. The Gatekeeper only relays them and
///         pays gas — it cannot forge a member's vote.
/// @dev    Runs behind DharmaProxy (ERC-1967): the proxy holds the address and all storage, and
///         `Upgrade` (a core change) points it at new code. Upgrades must keep this storage layout:
///         only ever append new state variables at the end.
contract Dharma {
    // ------------------------------------------------------------------ types

    enum Op {
        AddRule, RemoveRule, SetPayee, RemovePayee, SetAgent, RemoveAgent,
        AddDomain, RemoveDomain, SetThreshold, Freeze, Unfreeze, AddMember, RemoveMember,
        SetTimelock, SetCoreTimelock, Upgrade,
        SetLevel, SetLevelLimits // v3: trust levels
    }
    enum Outcome { Allow, Deny, Approval }
    enum Status { None, Open, Queued, Executed, Defeated, Cancelled }
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
        bool core; // core tier: every member, the core wait, no skip, cancelled by Freeze
        uint64 eta; // when it can be executed (set when it passes)
    }

    /// What an agent at a level may pay without asking (the policy engine adds the non-payment grants).
    struct LevelLimits {
        uint256 perPaymentMicroUsd;
        uint256 dailyMicroUsd;
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
    event ProposalCancelled(uint256 indexed id);
    event WaitSkipped(uint256 indexed id); // every member voted yes on a normal change
    event TimelockSet(uint64 secondsWait);
    event CoreTimelockSet(uint64 secondsWait);
    event Upgraded(address indexed implementation);
    event LogAnchored(bytes32 head, uint64 length);
    event ApprovalRequested(bytes32 indexed requestId, bytes32 indexed agent, uint256 amountMicroUsd, bytes32 payloadHash);
    event TestFailed(bytes32 indexed agent, string category);
    // v3
    event LevelSet(bytes32 indexed agent, uint8 level, address indexed by, string reason);
    event LevelLimitsSet(uint8 level, uint256 perPaymentMicroUsd, uint256 dailyMicroUsd);
    /// Running totals per agent, written with each log anchor: the onchain record trust levels read.
    event ActionsRecorded(bytes32 indexed agent, uint64 completed, uint64 denied);
    /// The wallet watchdog saw USDC leave the org's wallet that Karuna never approved.
    event UnapprovedTransfer(bytes32 indexed txHash, address indexed to, uint256 amountMicroUsd);
    /// An agent tripped a Tripwire (a trap password, or joining a swarm). Recorded per agent, so its
    /// record shows it even when the agent is already at Level 0.
    event TripwireFired(bytes32 indexed agent, string reason);

    // ------------------------------------------------------------------ errors

    error NotGatekeeper();
    error NotMember();
    error BadSignature();
    error Expired();
    error NotTightening();
    error MembersMustPropose();
    error UseTighten();
    error CoreBoundary();
    error Invalid(string why);
    error NotReady();
    error AlreadyInitialized();

    // ------------------------------------------------------------------ constants

    bytes32 public constant ACTION_TYPEHASH = keccak256(
        "Action(uint8 kind,uint8 op,bytes data,uint256 proposalId,bool support,uint256 nonce,uint256 deadline)"
    );
    uint64 public constant MAX_TIMELOCK = 7 days; // normal wait: 0 (a team's choice) … 7 days
    uint64 public constant MIN_CORE_TIMELOCK = 60; // core wait: never 0
    uint64 public constant MAX_CORE_TIMELOCK = 30 days;
    uint8 public constant MAX_LEVEL = 3;
    /// ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    // ------------------------------------------------------------------ storage (append only)

    bool internal _initialized;
    address public gatekeeper;
    uint64 public timelock; // normal wait, seconds
    uint64 public coreTimelock; // core wait, seconds
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
    uint256[] internal _pendingCore; // core proposals a Freeze would cancel

    // v3 (appended): trust levels. Every agent starts at Level 0. A level's limits fall back to the
    // defaults below until members change them by vote, so upgraded orgs need no migration.
    mapping(bytes32 => uint8) public agentLevel;
    mapping(uint8 => LevelLimits) internal _levelLimits;
    mapping(uint8 => bool) internal _levelLimitsSet;

    // ------------------------------------------------------------------ setup

    /// @dev The implementation itself can never be initialized: only proxies pointing at it.
    constructor() {
        _initialized = true;
    }

    /// @notice One-time setup, called by DharmaProxy's constructor in the same transaction.
    /// @param gatekeeper_ the org's Gatekeeper (relayer; may only tighten, anchor, and emit alerts)
    /// @param firstMember the first human's signing address (passed in, because a smart account
    ///        deploys through a factory and msg.sender is not the org)
    function initialize(
        address gatekeeper_,
        address firstMember,
        uint64 timelock_,
        uint64 coreTimelock_,
        uint256 thresholdMicroUsd_,
        string[] memory domains_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        if (gatekeeper_ == address(0) || firstMember == address(0)) revert Invalid("zero address");
        if (timelock_ > MAX_TIMELOCK) revert Invalid("wait too long");
        if (coreTimelock_ < MIN_CORE_TIMELOCK || coreTimelock_ > MAX_CORE_TIMELOCK) revert Invalid("bad core wait");
        gatekeeper = gatekeeper_;
        timelock = timelock_;
        coreTimelock = coreTimelock_;
        thresholdMicroUsd = thresholdMicroUsd_;
        _addMember(firstMember);
        for (uint256 i; i < domains_.length; i++) _addDomain(domains_[i]);

        // Karuna's default policy, in engine order. Core rules change only by a core (every-member) vote.
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

    /// @notice Apply a tightening right away. Only these paths are instant:
    ///         - the Gatekeeper with signer = 0 (Drills, Tripwire, learned blocks, level drops), tighten-only;
    ///         - a member's panic button (Freeze), or a member lowering one agent's level.
    ///         Every other change a member makes goes through propose → vote → timelock, even a tightening.
    function tighten(Op op, bytes calldata data, address signer, uint256 deadline, bytes calldata sig) external {
        address actor;
        if (signer == address(0)) {
            if (msg.sender != gatekeeper) revert NotGatekeeper();
            actor = gatekeeper;
        } else {
            _auth(Kind.Tighten, op, data, 0, false, signer, deadline, sig);
            if (op != Op.Freeze && op != Op.SetLevel) revert MembersMustPropose();
            actor = signer;
        }
        if (!isTightening(op, data)) revert NotTightening();
        _validate(op, data);
        _apply(op, data, actor);
        emit Tightened(op, actor);
    }

    /// @notice Propose any change (members' edits always go to a vote). The proposer's signature also
    ///         counts as their "yes" vote.
    function propose(Op op, bytes calldata data, address signer, uint256 deadline, bytes calldata sig) external returns (uint256 id) {
        _auth(Kind.Propose, op, data, 0, false, signer, deadline, sig);
        _validate(op, data);
        bool core = isCoreChange(op, data);
        id = _proposals.length;
        _proposals.push(Proposal(op, data, signer, uint64(block.timestamp), 0, 0, 0, Status.Open, core, 0));
        if (core) _pendingCore.push(id);
        emit ProposalCreated(id, op, signer, data);
        _count(id, signer, true);
    }

    /// @notice Vote on an open proposal. A normal change that already passed stays open to "yes"
    ///         votes: once every member has voted yes, its wait is skipped (not for Unfreeze or core).
    function vote(uint256 id, bool support, address signer, uint256 deadline, bytes calldata sig) external {
        if (id >= _proposals.length) revert Invalid("no such proposal");
        Proposal storage p = _proposals[id];
        _auth(Kind.Vote, p.op, p.data, id, support, signer, deadline, sig);
        bool skipVote = p.status == Status.Queued && support && _skippable(p);
        if (p.status != Status.Open && !skipVote) revert Invalid("voting closed");
        if (hasVoted[id][signer]) revert Invalid("already voted");
        _count(id, signer, support);
    }

    /// @notice Anyone may execute a passed proposal once its wait is over.
    function execute(uint256 id) external {
        if (id >= _proposals.length) revert Invalid("no such proposal");
        Proposal storage p = _proposals[id];
        if (p.status != Status.Queued || block.timestamp < p.eta) revert NotReady();
        _validate(p.op, p.data); // re-check against today's state
        p.status = Status.Executed;
        _apply(p.op, p.data, p.proposer);
        emit ProposalExecuted(id);
    }

    /// @notice Yes votes a normal change needs: a majority.
    function required() public view returns (uint32) {
        return uint32(_members.length / 2 + 1);
    }

    /// @notice Yes votes this proposal needs: every member for a core change, else a majority.
    function requiredFor(uint256 id) public view returns (uint32) {
        return _proposals[id].core ? uint32(_members.length) : required();
    }

    /// @notice Core changes: removing a core rule, changing the core wait, upgrading this code.
    function isCoreChange(Op op, bytes memory data) public view returns (bool) {
        if (op == Op.SetCoreTimelock || op == Op.Upgrade) return true;
        if (op == Op.RemoveRule) {
            bytes32 id = abi.decode(data, (bytes32));
            return _ruleKnown[id] && _rules[id].core;
        }
        return false;
    }

    /// @dev The every-member skip: normal changes only, never Unfreeze, and only in a team (2+).
    function _skippable(Proposal storage p) private view returns (bool) {
        return !p.core && p.op != Op.Unfreeze && _members.length >= 2;
    }

    function _count(uint256 id, address voter, bool support) private {
        Proposal storage p = _proposals[id];
        hasVoted[id][voter] = true;
        if (support) p.yes++;
        else p.no++;
        emit VoteCast(id, voter, support, p.yes, p.no);
        uint32 need = requiredFor(id);
        if (p.status == Status.Open) {
            if (p.yes >= need) {
                // The wait is fixed now, from today's setting: a later change to the wait never moves it.
                p.status = Status.Queued;
                p.queuedAt = uint64(block.timestamp);
                p.eta = uint64(block.timestamp) + (p.core ? coreTimelock : timelock);
                emit ProposalQueued(id, p.eta);
            } else if (p.no > _members.length - need) {
                p.status = Status.Defeated;
                emit ProposalDefeated(id);
                return;
            }
        }
        if (p.status == Status.Queued && p.yes >= _members.length && _skippable(p) && p.eta > block.timestamp) {
            p.eta = uint64(block.timestamp);
            emit WaitSkipped(id);
            emit ProposalQueued(id, p.eta);
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

    /// @notice Anchor the log and publish each agent's running totals in the same transaction.
    function anchorWithRecord(bytes32 head, uint64 length, bytes32[] calldata agents_, uint64[] calldata completed, uint64[] calldata denied)
        external
    {
        if (msg.sender != gatekeeper) revert NotGatekeeper();
        if (length < logLength) revert Invalid("log cannot shrink");
        if (agents_.length != completed.length || agents_.length != denied.length) revert Invalid("length mismatch");
        logHead = head;
        logLength = length;
        emit LogAnchored(head, length);
        for (uint256 i; i < agents_.length; i++) emit ActionsRecorded(agents_[i], completed[i], denied[i]);
    }

    /// @notice Public record that an agent tripped a Tripwire.
    function reportTripwire(bytes32 agent, string calldata reason) external {
        if (msg.sender != gatekeeper) revert NotGatekeeper();
        emit TripwireFired(agent, reason);
    }

    /// @notice Public record that USDC left the org's wallet without Karuna's approval.
    function reportUnapprovedTransfer(bytes32 txHash, address to, uint256 amountMicroUsd) external {
        if (msg.sender != gatekeeper) revert NotGatekeeper();
        emit UnapprovedTransfer(txHash, to, amountMicroUsd);
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
        if (op == Op.SetLevel) {
            (bytes32 id, uint8 level,) = abi.decode(data, (bytes32, uint8, string));
            return _agentIdx[id] != 0 && level < agentLevel[id];
        }
        if (op == Op.SetLevelLimits) {
            (uint8 level, uint256 per, uint256 daily) = abi.decode(data, (uint8, uint256, uint256));
            if (level > MAX_LEVEL) return false;
            LevelLimits memory cur = levelLimits(level);
            return per <= cur.perPaymentMicroUsd && daily <= cur.dailyMicroUsd;
        }
        return op == Op.RemovePayee || op == Op.RemoveAgent || op == Op.RemoveDomain || op == Op.Freeze;
        // SetPayee, AddDomain, Unfreeze, AddMember, RemoveMember, and the waits and upgrades are
        // never instant: they always go to a vote.
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
            // A core rule can be removed, but only as a core change (every member + the core wait):
            // propose() marks it core, and tighten() can never remove a deny rule.
        } else if (op == Op.SetTimelock) {
            if (abi.decode(data, (uint64)) > MAX_TIMELOCK) revert Invalid("wait too long");
        } else if (op == Op.SetCoreTimelock) {
            uint64 w = abi.decode(data, (uint64));
            if (w < MIN_CORE_TIMELOCK || w > MAX_CORE_TIMELOCK) revert Invalid("bad core wait");
        } else if (op == Op.Upgrade) {
            address impl = abi.decode(data, (address));
            if (impl.code.length == 0 || impl == implementation()) revert Invalid("bad implementation");
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
        } else if (op == Op.SetLevel) {
            (bytes32 id, uint8 level,) = abi.decode(data, (bytes32, uint8, string));
            if (_agentIdx[id] == 0) revert Invalid("no such agent");
            if (level > MAX_LEVEL || level == agentLevel[id]) revert Invalid("bad level");
        } else if (op == Op.SetLevelLimits) {
            (uint8 level, uint256 per, uint256 daily) = abi.decode(data, (uint8, uint256, uint256));
            if (level > MAX_LEVEL || per > daily) revert Invalid("bad level limits");
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
            delete agentLevel[id];
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
            // A freeze also cancels every pending core change (core rules, the core wait, upgrades).
            for (uint256 i; i < _pendingCore.length; i++) {
                Proposal storage p = _proposals[_pendingCore[i]];
                if (p.status == Status.Open || p.status == Status.Queued) {
                    p.status = Status.Cancelled;
                    emit ProposalCancelled(_pendingCore[i]);
                }
            }
            delete _pendingCore;
        } else if (op == Op.SetTimelock) {
            timelock = abi.decode(data, (uint64));
            emit TimelockSet(timelock);
        } else if (op == Op.SetCoreTimelock) {
            coreTimelock = abi.decode(data, (uint64));
            emit CoreTimelockSet(coreTimelock);
        } else if (op == Op.Upgrade) {
            address impl = abi.decode(data, (address));
            assembly {
                sstore(IMPLEMENTATION_SLOT, impl)
            }
            emit Upgraded(impl);
        } else if (op == Op.Unfreeze) {
            frozen = false;
            emit AgentsUnfrozen();
        } else if (op == Op.AddMember) {
            _addMember(abi.decode(data, (address)));
        } else if (op == Op.RemoveMember) {
            address m = abi.decode(data, (address));
            _removeAddr(_members, _memberIdx, m);
            emit MemberRemoved(m);
        } else if (op == Op.SetLevel) {
            (bytes32 id, uint8 level, string memory reason) = abi.decode(data, (bytes32, uint8, string));
            agentLevel[id] = level;
            emit LevelSet(id, level, actor, reason);
        } else if (op == Op.SetLevelLimits) {
            (uint8 level, uint256 per, uint256 daily) = abi.decode(data, (uint8, uint256, uint256));
            _levelLimits[level] = LevelLimits(per, daily);
            _levelLimitsSet[level] = true;
            emit LevelLimitsSet(level, per, daily);
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

    /// @notice EIP-712 domain: bound to this org's address (the proxy) and chain, so a signature for
    ///         one org can never be replayed on another. Stays the same across upgrades.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Dharma"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function actionDigest(Kind kind, Op op, bytes memory data, uint256 proposalId, bool support, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(ACTION_TYPEHASH, uint8(kind), uint8(op), keccak256(data), proposalId, support, nonce, deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
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

    /// @notice The code version behind this org's address.
    function version() external pure virtual returns (uint256) {
        return 3;
    }

    /// @notice A level's payment limits: the members' values if they set them, else the defaults.
    function levelLimits(uint8 level) public view returns (LevelLimits memory) {
        if (level > MAX_LEVEL) revert Invalid("bad level");
        if (_levelLimitsSet[level]) return _levelLimits[level];
        if (level == 0) return LevelLimits(0.1e6, 1e6);
        if (level == 1) return LevelLimits(0.5e6, 5e6);
        if (level == 2) return LevelLimits(2e6, 20e6);
        return LevelLimits(5e6, 50e6);
    }

    /// @notice Every agent's level, in the same order as `agents()`.
    function levels() external view returns (bytes32[] memory ids, uint8[] memory lvls) {
        ids = _agentIds;
        lvls = new uint8[](ids.length);
        for (uint256 i; i < ids.length; i++) lvls[i] = agentLevel[ids[i]];
    }

    /// @notice The code this org's proxy currently runs.
    function implementation() public view returns (address impl) {
        assembly {
            impl := sload(IMPLEMENTATION_SLOT)
        }
    }

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
