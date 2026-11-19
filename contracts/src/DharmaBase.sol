// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DharmaBase: what both halves of Dharma share
/// @notice Types, events, errors, constants, the storage layout, and the internal logic both halves
///         use. Dharma (the hot path) and DharmaExt (setup, roles, Gatekeeper reports, views) both
///         inherit it and run on the same storage: the org's DharmaProxy.
/// @dev    Storage is append only, in this order, across every version (v1 to v5 declared it in
///         Dharma itself; the layout is unchanged). Public state variables and constants here get
///         a getter in both halves; Dharma's own copy answers, so they never reach the fallback.
abstract contract DharmaBase {
    // ------------------------------------------------------------------ types

    enum Op {
        AddRule, RemoveRule, SetPayee, RemovePayee, SetAgent, RemoveAgent,
        AddDomain, RemoveDomain, SetThreshold, Freeze, Unfreeze, AddMember, RemoveMember,
        SetTimelock, SetCoreTimelock, Upgrade,
        SetLevel, SetLevelLimits, // v3: trust levels
        SetRole, SetRolePerms, SetStructure // v4: team roles (instant, via manage)
    }
    enum Outcome { Allow, Deny, Approval }
    enum Status { None, Open, Queued, Executed, Defeated, Cancelled }
    enum Kind { Tighten, Propose, Vote, Manage }

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
    // v4: team roles
    event RoleSet(address indexed member, uint8 role, address indexed by);
    event RolePermsSet(uint8 role, uint16 perms, address indexed by);
    event StructureSet(uint8 structure, address indexed by);

    // ------------------------------------------------------------------ errors

    error NotGatekeeper();
    error NotMember();
    error BadSignature();
    error Expired();
    error NotTightening();
    error MembersMustPropose();
    error UseTighten();
    error CoreBoundary();
    error Invalid(string why); // older Dharma versions; kept so their reverts still decode
    error AlreadyFrozen();
    error AlreadyVoted();
    error BadAgent();
    error BadCoreWait();
    error BadDomain();
    error BadImplementation();
    error BadLevel();
    error BadLevelLimits();
    error BadMember();
    error BadRule();
    error CannotRemove();
    error LengthMismatch();
    error LogCannotShrink();
    error NoSuchAgent();
    error NoSuchDomain();
    error NoSuchPayee();
    error NoSuchProposal();
    error NoSuchRule();
    error NotFrozen();
    error RuleExists();
    error VotingClosed();
    error WaitTooLong();
    error ZeroAddress();
    error NotReady();
    error AlreadyInitialized();
    error NoPermission();
    error BadRole();

    // ------------------------------------------------------------------ constants

    bytes32 public constant ACTION_TYPEHASH = keccak256(
        "Action(uint8 kind,uint8 op,bytes data,uint256 proposalId,bool support,uint256 nonce,uint256 deadline)"
    );
    uint64 public constant MAX_TIMELOCK = 7 days; // normal wait: 0 (a team's choice) … 7 days
    uint64 public constant MIN_CORE_TIMELOCK = 60; // core wait: never 0
    uint64 public constant MAX_CORE_TIMELOCK = 30 days;
    uint8 public constant MAX_LEVEL = 3;
    // v4 team roles. Permission bits (same order as the console's list).
    uint16 internal constant P_APPROVE = 1; // approve or deny held actions (checked by the Gatekeeper)
    uint16 internal constant P_CANCEL_ESCROW = 2; // cancel a payment in escrow (checked by Escrow)
    uint16 internal constant P_PROPOSE = 4; // propose changes (voting is every member's, always)
    uint16 internal constant P_AGENTS = 8; // manage agents, and lower an agent's level at once
    uint16 internal constant P_TEAM = 16; // change roles and the team structure
    uint16 internal constant P_WALLET = 32; // manage the wallet (checked by the Gatekeeper)
    uint16 internal constant P_FREEZE = 64; // freeze every agent at once
    uint16 internal constant P_ALL = 127;
    uint16 internal constant MEMBER_DEFAULT = 15; // approve, cancel escrow, propose, agents
    uint8 internal constant ROLE_DEFAULT = 0; // Flat: everything; Tree: Member
    uint8 internal constant ROLE_ADMIN = 1; // everything, always
    uint8 internal constant ROLE_MEMBER = 2; // its permissions can change
    uint8 internal constant STRUCTURE_FLAT = 0;
    uint8 internal constant STRUCTURE_TREE = 1;
    /// `_subject`'s group for each Op, one byte per op in enum order.
    bytes32 internal constant SUBJECT_GROUPS = 0x0101020203030404050606000000000003070000000000000000000000000000;
    uint8 internal constant MAX_ROLE = 15; // 2 = Member, 3..15 custom
    uint16 internal constant DELETE_ROLE = 0x8000; // SetRolePerms with this deletes a custom role
    uint16 internal constant ROLE_EXISTS = 0x4000;
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
    mapping(bytes32 => uint256) internal agentCap; // read with agents()

    string[] internal _domains;
    mapping(bytes32 => uint256) internal _domainIdx;

    Proposal[] internal _proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    uint256[] internal _pendingCore; // core proposals a Freeze would cancel

    // v3 (appended): trust levels. Every agent starts at Level 0. A level's limits fall back to the
    // defaults below until members change them by vote, so upgraded orgs need no migration.
    mapping(bytes32 => uint8) internal agentLevel; // read with levels()
    mapping(uint8 => LevelLimits) internal _levelLimits;
    mapping(uint8 => bool) internal _levelLimitsSet;

    // v4 (appended): team roles. Flat (0) until a member with "team" picks Tree, so upgraded and
    // new orgs work exactly as before roles existed: every member can do everything.
    uint8 public structure;
    mapping(address => uint8) public roleOf; // 0 = the structure's default role
    mapping(uint8 => uint16) internal _rolePerms; // with ROLE_EXISTS set once a role is defined

    // v5 (appended).
    /// When something was last tightened at once (by subject, see `_subject`). A loosening proposed
    /// before that is cancelled instead of executed: voters never saw the tightening it would undo.
    mapping(bytes32 => uint64) internal _tightenedAt;
    /// Bumps whenever a member joins or leaves. A proposal remembers it (+1; 0 = made before v5):
    /// votes cast under another team don't count toward today's, so such a proposal is cancelled
    /// the next time someone votes on it, and gets proposed again.
    uint64 internal _teamEpoch;
    mapping(uint256 => uint64) internal _epochOf;
    /// Each proposal's `_subject`, fixed when it's made.
    mapping(uint256 => bytes32) internal _subjectOf;

    // ------------------------------------------------------------------ shared logic (internal)
    // Compiled into whichever half calls it: Dharma (the hot path) or DharmaExt (views, setup).

    /// @dev Yes votes a normal change needs: a majority.
    function _required() internal view returns (uint32) {
        return uint32(_members.length / 2 + 1);
    }

    /// @dev Yes votes this proposal needs: every member for a core change, else a majority.
    ///      Removing a member needs everyone but that member (at least a majority), so a bare
    ///      majority can't vote out whoever stands in the way of an every-member change.
    function _requiredFor(uint256 id) internal view returns (uint32) {
        Proposal storage p = _proposals[id];
        uint32 n = uint32(_members.length);
        if (p.core) return n;
        uint32 m = _required();
        return p.op == Op.RemoveMember && n - 1 > m ? n - 1 : m;
    }

    /// @dev Core changes: removing a core rule, changing the core wait, upgrading this code.
    function _isCoreChange(Op op, bytes memory data) internal view returns (bool) {
        if (op == Op.SetCoreTimelock || op == Op.Upgrade) return true;
        if (op == Op.RemoveRule) {
            bytes32 id = abi.decode(data, (bytes32));
            return _ruleKnown[id] && _rules[id].core;
        }
        return false;
    }

    /// @dev What a member may do (0 for anyone else). There's always someone with "team": in a
    ///      Tree with nobody left who has it, the first member does.
    function _permissionsOf(address a) internal view returns (uint16) {
        if (_memberIdx[a] == 0) return 0;
        uint16 p = _base(a);
        if (p & P_TEAM == 0 && _members[0] == a) {
            for (uint256 i; i < _members.length; i++) if (_base(_members[i]) & P_TEAM != 0) return p;
            return P_ALL;
        }
        return p;
    }

    /// @dev A role's permissions with ROLE_EXISTS, or 0 when there's no such role.
    function _permsOfRole(uint8 r) internal view returns (uint16) {
        if (r == ROLE_ADMIN) return P_ALL | ROLE_EXISTS;
        uint16 p = _rolePerms[r];
        return r == ROLE_MEMBER && p == 0 ? MEMBER_DEFAULT | ROLE_EXISTS : p;
    }

    /// @dev A member's permissions from their role, or the structure's default when they have none.
    function _base(address m) internal view returns (uint16) {
        uint16 p = _permsOfRole(roleOf[m]);
        if (p & ROLE_EXISTS != 0) return p & P_ALL;
        return structure == STRUCTURE_FLAT ? P_ALL : _permsOfRole(ROLE_MEMBER) & P_ALL;
    }

    function _isRoleOp(Op op) internal pure returns (bool) {
        return op >= Op.SetRole; // the role ops are the last ones
    }

    function _setStructure(uint8 st, address by) internal {
        structure = st;
        // Whoever sets up a Tree becomes its Admin (unless they already have a role).
        if (st == STRUCTURE_TREE && roleOf[by] == ROLE_DEFAULT) {
            roleOf[by] = ROLE_ADMIN;
            emit RoleSet(by, ROLE_ADMIN, by);
        }
        emit StructureSet(st, by);
    }

    /// @dev True when applying this change can only make the policy stricter.
    function _isTightening(Op op, bytes memory data) internal view returns (bool) {
        if (op == Op.AddRule) {
            // A block, or an approval rule for one agent (a pre-flight fix: "this agent's shell
            // commands need a person"). An org-wide approval rule can loosen, so it's voted: it can
            // turn a hard deny later in the order into something approvable, and org settings are
            // stored as org-wide approval rules. A default rule keeps its own outcome.
            (bytes32 id, uint8 outcome, bytes32 agent,,,) = abi.decode(data, (bytes32, uint8, bytes32, string, string, uint256));
            if (_ruleKnown[id] && _rules[id].builtin) return _rules[id].outcome == Outcome.Deny;
            return Outcome(outcome) == Outcome.Deny || (Outcome(outcome) == Outcome.Approval && agent != 0);
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
            LevelLimits memory cur = _limitsOf(level);
            return per <= cur.perPaymentMicroUsd && daily <= cur.dailyMicroUsd;
        }
        return op == Op.RemovePayee || op == Op.RemoveAgent || op == Op.RemoveDomain || op == Op.Freeze;
        // SetPayee, AddDomain, Unfreeze, AddMember, RemoveMember, and the waits and upgrades are
        // never instant: they always go to a vote.
    }

    /// @dev A level's payment limits: the members' values if they set them, else the defaults.
    function _limitsOf(uint8 level) internal view returns (LevelLimits memory) {
        if (level > MAX_LEVEL) revert BadLevel();
        if (_levelLimitsSet[level]) return _levelLimits[level];
        if (level == 0) return LevelLimits(0.1e6, 1e6);
        if (level == 1) return LevelLimits(0.5e6, 5e6);
        if (level == 2) return LevelLimits(2e6, 20e6);
        return LevelLimits(5e6, 50e6);
    }

    /// @dev The code this org's proxy currently runs.
    function _implementation() internal view returns (address impl) {
        assembly {
            impl := sload(IMPLEMENTATION_SLOT)
        }
    }

    function _addMember(address m) internal {
        _teamEpoch++;
        _members.push(m);
        _memberIdx[m] = _members.length;
        emit MemberAdded(m);
    }

    function _addDomain(string memory d) internal {
        _domains.push(d);
        _domainIdx[keccak256(bytes(d))] = _domains.length;
        emit DomainAdded(d);
    }

    function _removeAddr(address[] storage list, mapping(address => uint256) storage idx, address a) internal {
        uint256 i = idx[a] - 1;
        address last = list[list.length - 1];
        list[i] = last;
        idx[last] = i + 1;
        list.pop();
        delete idx[a];
    }

    /// @dev EIP-712 domain: bound to this org's address (the proxy) and chain, so a signature for
    ///      one org can never be replayed on another. Stays the same across upgrades.
    function _domainSeparator() internal view returns (bytes32) {
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

    function _digest(Kind kind, Op op, bytes memory data, uint256 proposalId, bool support, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(ACTION_TYPEHASH, uint8(kind), uint8(op), keccak256(data), proposalId, support, nonce, deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _auth(Kind kind, Op op, bytes memory data, uint256 proposalId, bool support, address signer, uint256 deadline, bytes calldata sig)
        internal
    {
        if (block.timestamp > deadline) revert Expired();
        if (_memberIdx[signer] == 0) revert NotMember();
        bytes32 digest = _digest(kind, op, data, proposalId, support, nonces[signer], deadline);
        if (_recover(digest, sig) != signer) revert BadSignature();
        nonces[signer]++;
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
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
}
