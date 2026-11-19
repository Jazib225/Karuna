// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DharmaBase} from "./DharmaBase.sol";

/// @title DharmaExt: the second half of Dharma's code (v6+)
/// @notice Setup, team roles, the Gatekeeper's reports and anchors, and every view. It never runs
///         on its own: Dharma forwards the calls it doesn't recognize here with DELEGATECALL, so this
///         code reads and writes the org's storage (the DharmaProxy) and emits from the org's address.
/// @dev    Holds no state of its own. Called directly, it sees empty storage: no gatekeeper and no
///         members, so every write reverts.
contract DharmaExt is DharmaBase {
    constructor() {
        _initialized = true;
    }

    // ------------------------------------------------------------------ setup

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
        if (gatekeeper_ == address(0) || firstMember == address(0)) revert ZeroAddress();
        if (timelock_ > MAX_TIMELOCK) revert WaitTooLong();
        if (coreTimelock_ < MIN_CORE_TIMELOCK || coreTimelock_ > MAX_CORE_TIMELOCK) revert BadCoreWait();
        gatekeeper = gatekeeper_;
        timelock = timelock_;
        coreTimelock = coreTimelock_;
        thresholdMicroUsd = thresholdMicroUsd_;
        _addMember(firstMember);
        _host = firstMember; // v7: whoever sets the org up is its host
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

    // ------------------------------------------------------------------ team roles (v4)

    // ------------------------------------------------------------------ team roles (v4)

    /// @notice A member with "team" changes roles or the team structure, at once. Roles limit what
    ///         a member may do; they never change who votes, so this can't pass or block a proposal.
    function manage(Op op, bytes calldata data, address signer, uint256 deadline, bytes calldata sig) external {
        _auth(Kind.Manage, op, data, 0, false, signer, deadline, sig);
        if (!_isRoleOp(op)) revert BadRole();
        if (_permissionsOf(signer) & P_TEAM == 0) revert NoPermission();
        policyVersion++;
        if (op == Op.SetRole) {
            (address m, uint8 r) = abi.decode(data, (address, uint8));
            if (_memberIdx[m] == 0) revert NotMember();
            if (r > ROLE_MEMBER && _rolePerms[r] == 0) revert BadRole();
            roleOf[m] = r;
            emit RoleSet(m, r, signer);
        } else if (op == Op.SetRolePerms) {
            // Deleting a custom role: whoever still has it falls back to the default role.
            (uint8 r, uint16 perms) = abi.decode(data, (uint8, uint16));
            bool del = perms == DELETE_ROLE;
            if (r < ROLE_MEMBER || r > MAX_ROLE || (del ? r == ROLE_MEMBER : perms > P_ALL)) revert BadRole();
            _rolePerms[r] = del ? 0 : perms | ROLE_EXISTS;
            emit RolePermsSet(r, perms, signer);
            // Its holders go back to the default now, so a role made later with this id isn't theirs.
            if (del) {
                for (uint256 i; i < _members.length; i++) {
                    if (roleOf[_members[i]] == r) {
                        roleOf[_members[i]] = ROLE_DEFAULT;
                        emit RoleSet(_members[i], ROLE_DEFAULT, signer);
                    }
                }
            }
        } else {
            uint8 st = abi.decode(data, (uint8));
            if (st > STRUCTURE_TREE) revert BadRole();
            // In a flat team everyone has "team", so one member making it a tree (and themselves its
            // Admin) would take the others' rights alone: with two or more members that's voted.
            if (st == STRUCTURE_TREE && structure == STRUCTURE_FLAT && _members.length > 1) revert MembersMustPropose();
            _setStructure(st, signer);
        }
    }

    // ------------------------------------------------------------------ gatekeeper-only

    /// @notice Anchor the signed decision log. Length can only grow, so history can't be rewound.
    function anchorLog(bytes32 head, uint64 length) external {
        if (msg.sender != gatekeeper) revert NotGatekeeper();
        if (length < logLength) revert LogCannotShrink();
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
        if (length < logLength) revert LogCannotShrink();
        if (agents_.length != completed.length || agents_.length != denied.length) revert LengthMismatch();
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

    // ------------------------------------------------------------------ views

    /// @notice Yes votes a normal change needs: a majority.
    function required() external view returns (uint32) {
        return _required();
    }

    /// @notice Yes votes this proposal needs: every member for a core change, else a majority
    ///         (removing a member: everyone but them).
    function requiredFor(uint256 id) external view returns (uint32) {
        return _requiredFor(id);
    }

    /// @notice Core changes: removing a core rule, changing the core wait, upgrading this code.
    function isCoreChange(Op op, bytes memory data) external view returns (bool) {
        return _isCoreChange(op, data);
    }

    /// @notice True when applying this change can only make the policy stricter.
    function isTightening(Op op, bytes memory data) external view returns (bool) {
        return _isTightening(op, data);
    }

    /// @notice What a member may do (0 for anyone else).
    function permissionsOf(address a) external view returns (uint16) {
        return _permissionsOf(a);
    }

    /// @notice Every role's permissions, 16 bits per role id (2 = Member, 3..15 custom); a role
    ///         exists when its ROLE_EXISTS bit (0x4000) is set.
    function rolePerms() external view returns (uint256 packed) {
        for (uint8 r = ROLE_MEMBER; r <= MAX_ROLE; r++) packed |= uint256(_permsOfRole(r)) << (16 * uint256(r));
    }

    /// @notice A level's payment limits: the members' values if they set them, else the defaults.
    function levelLimits(uint8 level) external view returns (LevelLimits memory) {
        return _limitsOf(level);
    }

    /// @notice Every agent's level, in the same order as `agents()`.
    function levels() external view returns (bytes32[] memory ids, uint8[] memory lvls) {
        ids = _agentIds;
        lvls = new uint8[](ids.length);
        for (uint256 i; i < ids.length; i++) lvls[i] = agentLevel[ids[i]];
    }

    /// @notice The code this org's proxy currently runs (its Dharma half).
    function implementation() external view returns (address) {
        return _implementation();
    }

    /// @notice v7: the host (who set the org up), or 0 once they're no longer a member.
    function host() external view returns (address) {
        return _hostOf();
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

    /// @notice One payee check at constant cost (Escrow uses it on every open and release).
    function isPayee(address a) external view returns (bool) {
        return _payeeIdx[a] != 0;
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

    /// @notice EIP-712 domain separator for members' signed actions.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparator();
    }

    function actionDigest(Kind kind, Op op, bytes memory data, uint256 proposalId, bool support, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _digest(kind, op, data, proposalId, support, nonce, deadline);
    }
}
