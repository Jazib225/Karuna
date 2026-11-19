// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DharmaBase} from "./DharmaBase.sol";

/// @title Dharma — Karuna's onchain rulebook (CLAUDE.md §1, §2)
/// @notice Holds an organization's policy: rules, core boundaries, payees, agent allowances,
///         allowlisted domains, the two-person threshold, members, the freeze switch, and the waits.
///         Two tiers of change:
///         - Normal changes: proposed, passed by a majority, applied after the wait (`timelock`).
///           If every member votes yes (2+ members), the wait is skipped — except for Unfreeze.
///         - Core changes (removing a core rule, the core wait itself, upgrading this code): need every
///           member, always wait `coreTimelock`, can't be skipped, and any member's Freeze cancels them.
///         Only two things are instant: a member's Freeze, and the Gatekeeper's own tighten-only writes.
///         v4 team roles: what each member may do (propose, freeze, lower a level, manage roles…) is a
///         role. A member with "team" changes roles at once (`manage`); roles never change who votes,
///         and every member can always vote, so no role change can pass or block a proposal.
///         A changed wait applies to proposals that pass after it, never to ones already waiting.
///         v5: a loosening proposed before an instant tightening of the same thing is cancelled, not
///         executed; only blocks and one agent's approval rules are instant; removing a member needs everyone
///         else and the core wait; a proposal left open across a team change is cancelled; a flat
///         team of two or more votes on becoming a tree; deleting a role takes it from its holders.
///         Members sign EIP-712 actions with their own keys. The Gatekeeper only relays them and
///         pays gas — it cannot forge a member's vote.
///         v6: the code is two contracts. Dharma (this one) runs proposals, votes, execution and
///         instant tightening. Anything else (setup, roles, the Gatekeeper's reports, every view)
///         is in DharmaExt: a call Dharma doesn't recognize is forwarded to it, on this storage.
///         v7: the host (the member who set the org up) may remove a teammate without a vote. It still
///         waits the core wait in public, can't start while frozen, and any member's Freeze cancels it.
/// @dev    Runs behind DharmaProxy (ERC-1967): the proxy holds the address and all storage, and
///         `Upgrade` (a core change) points it at new code. Each Dharma names its DharmaExt in its
///         code (an immutable), so one Upgrade moves both halves. Storage lives in DharmaBase:
///         only ever append new state variables at the end.
contract Dharma is DharmaBase {
    /// @notice The other half of this version's code (setup, roles, reports, views).
    address public immutable ext;

    /// @dev The implementation itself can never be initialized: only proxies pointing at it.
    constructor(address ext_) {
        if (ext_.code.length == 0) revert ZeroAddress();
        ext = ext_;
        _initialized = true;
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
            if (_permissionsOf(signer) & (op == Op.Freeze ? P_FREEZE : P_AGENTS) == 0) revert NoPermission();
            actor = signer;
        }
        if (!_isTightening(op, data)) revert NotTightening();
        _validate(op, data);
        _apply(op, data, actor);
        _tightenedAt[_subject(op, data)] = uint64(block.timestamp);
        emit Tightened(op, actor);
    }

    /// @notice Propose any change (members' edits always go to a vote). The proposer's signature also
    ///         counts as their "yes" vote.
    function propose(Op op, bytes calldata data, address signer, uint256 deadline, bytes calldata sig) external returns (uint256 id) {
        _auth(Kind.Propose, op, data, 0, false, signer, deadline, sig);
        // Roles apply at once via manage; only a team's switch to a tree is voted (see manage).
        if (_isRoleOp(op) && op != Op.SetStructure) revert BadRole();
        if (_permissionsOf(signer) & P_PROPOSE == 0) revert NoPermission();
        _validate(op, data);
        bool core = _isCoreChange(op, data);
        id = _proposals.length;
        _proposals.push(Proposal(op, data, signer, uint64(block.timestamp), 0, 0, 0, Status.Open, core, 0));
        _epochOf[id] = _teamEpoch + 1;
        _subjectOf[id] = _subject(op, data);
        if (core) _pendingCore.push(id);
        emit ProposalCreated(id, op, signer, data);
        _count(id, signer, true);
    }

    /// @notice Vote on an open proposal. A normal change that already passed stays open to "yes"
    ///         votes: once every member has voted yes, its wait is skipped (not for Unfreeze or core).
    function vote(uint256 id, bool support, address signer, uint256 deadline, bytes calldata sig) external {
        if (id >= _proposals.length) revert NoSuchProposal();
        Proposal storage p = _proposals[id];
        _auth(Kind.Vote, p.op, p.data, id, support, signer, deadline, sig);
        bool skipVote = p.status == Status.Queued && support && _skippable(p);
        if (p.status != Status.Open && !skipVote) revert VotingClosed();
        if (hasVoted[id][signer]) revert AlreadyVoted();
        _count(id, signer, support);
    }

    /// @notice v7: the host removes a teammate without a vote. Not instant: it's queued for the core
    ///         wait, in public, so everyone sees it coming; any member's Freeze cancels it (and while
    ///         frozen the host can't start one). Signed with Kind.Manage + Op.RemoveMember, which
    ///         `manage` itself never accepts, so no other signature can be replayed here.
    function hostRemove(address member, address signer, uint256 deadline, bytes calldata sig) external returns (uint256 id) {
        bytes memory data = abi.encode(member);
        _auth(Kind.Manage, Op.RemoveMember, data, 0, false, signer, deadline, sig);
        if (signer != _hostOf()) revert NoPermission();
        if (member == signer) revert CannotRemove();
        if (frozen) revert AlreadyFrozen();
        _validate(Op.RemoveMember, data);
        _pinHost();
        uint64 eta = uint64(block.timestamp) + coreTimelock;
        id = _proposals.length;
        _proposals.push(Proposal(Op.RemoveMember, data, signer, uint64(block.timestamp), uint64(block.timestamp), 1, 0, Status.Queued, true, eta));
        hasVoted[id][signer] = true;
        _pendingCore.push(id); // a Freeze cancels it, like every core change
        emit ProposalCreated(id, Op.RemoveMember, signer, data);
        emit ProposalQueued(id, eta);
    }

    /// @notice Anyone may execute a passed proposal once its wait is over.
    function execute(uint256 id) external {
        if (id >= _proposals.length) revert NoSuchProposal();
        Proposal storage p = _proposals[id];
        if (p.status != Status.Queued || block.timestamp < p.eta) revert NotReady();
        // A loosening proposed before an instant tightening of the same thing (a level drop, a cap
        // cut, a Shield block, a freeze) would undo it without a vote that saw it: cancel instead.
        bytes32 subject = _subjectOf[id];
        if (subject != 0 && _tightenedAt[subject] > p.createdAt && !_isTightening(p.op, p.data)) {
            p.status = Status.Cancelled;
            emit ProposalCancelled(id);
            return;
        }
        _validate(p.op, p.data); // re-check against today's state
        p.status = Status.Executed;
        _apply(p.op, p.data, p.proposer);
        emit ProposalExecuted(id);
    }

    /// @dev The every-member skip: normal changes only, never Unfreeze or removing a member, and only
    ///      in a team (2+).
    function _skippable(Proposal storage p) internal view returns (bool) {
        return !p.core && p.op != Op.Unfreeze && p.op != Op.RemoveMember && _members.length >= 2;
    }

    function _count(uint256 id, address voter, bool support) internal {
        Proposal storage p = _proposals[id];
        uint64 e = _epochOf[id];
        if (e != 0 && e != _teamEpoch + 1) {
            // The team changed while it was waiting for votes: its count no longer matches who votes.
            p.status = Status.Cancelled;
            emit ProposalCancelled(id);
            return;
        }
        hasVoted[id][voter] = true;
        if (support) p.yes++;
        else p.no++;
        emit VoteCast(id, voter, support, p.yes, p.no);
        uint32 need = _requiredFor(id);
        if (p.status == Status.Open) {
            if (p.yes >= need) {
                // The wait is fixed now, from today's setting: a later change to the wait never moves it.
                // Removing a member waits the core wait, so they have time to see it coming.
                p.status = Status.Queued;
                p.queuedAt = uint64(block.timestamp);
                p.eta = uint64(block.timestamp) + (p.core || p.op == Op.RemoveMember ? coreTimelock : timelock);
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

    // ------------------------------------------------------------------ validation + effects

    function _validate(Op op, bytes memory data) internal view {
        if (op == Op.AddRule) {
            (bytes32 id, uint8 outcome,,,,) = abi.decode(data, (bytes32, uint8, bytes32, string, string, uint256));
            if (id == bytes32(0) || outcome > uint8(Outcome.Approval)) revert BadRule();
            if (_ruleKnown[id] && _rules[id].active) revert RuleExists();
        } else if (op == Op.RemoveRule) {
            bytes32 id = abi.decode(data, (bytes32));
            if (!_ruleKnown[id] || !_rules[id].active) revert NoSuchRule();
            // A core rule can be removed, but only as a core change (every member + the core wait):
            // propose() marks it core, and tighten() can never remove a deny rule.
        } else if (op == Op.SetTimelock) {
            if (abi.decode(data, (uint64)) > MAX_TIMELOCK) revert WaitTooLong();
        } else if (op == Op.SetCoreTimelock) {
            uint64 w = abi.decode(data, (uint64));
            if (w < MIN_CORE_TIMELOCK || w > MAX_CORE_TIMELOCK) revert BadCoreWait();
        } else if (op == Op.Upgrade) {
            address impl = abi.decode(data, (address));
            if (impl.code.length == 0 || impl == _implementation()) revert BadImplementation();
        } else if (op == Op.SetPayee) {
            (address a,) = abi.decode(data, (address, string));
            if (a == address(0)) revert ZeroAddress();
        } else if (op == Op.RemovePayee) {
            if (_payeeIdx[abi.decode(data, (address))] == 0) revert NoSuchPayee();
        } else if (op == Op.SetAgent) {
            (bytes32 id,) = abi.decode(data, (bytes32, uint256));
            if (id == bytes32(0)) revert BadAgent();
        } else if (op == Op.RemoveAgent) {
            if (_agentIdx[abi.decode(data, (bytes32))] == 0) revert NoSuchAgent();
        } else if (op == Op.AddDomain) {
            string memory d = abi.decode(data, (string));
            if (bytes(d).length == 0 || _domainIdx[keccak256(bytes(d))] != 0) revert BadDomain();
        } else if (op == Op.RemoveDomain) {
            if (_domainIdx[keccak256(bytes(abi.decode(data, (string))))] == 0) revert NoSuchDomain();
        } else if (op == Op.Freeze) {
            if (frozen) revert AlreadyFrozen();
        } else if (op == Op.Unfreeze) {
            if (!frozen) revert NotFrozen();
        } else if (op == Op.AddMember) {
            address m = abi.decode(data, (address));
            if (m == address(0) || _memberIdx[m] != 0) revert BadMember();
        } else if (op == Op.RemoveMember) {
            address m = abi.decode(data, (address));
            if (_memberIdx[m] == 0 || _members.length == 1) revert CannotRemove();
        } else if (op == Op.SetLevel) {
            (bytes32 id, uint8 level,) = abi.decode(data, (bytes32, uint8, string));
            if (_agentIdx[id] == 0) revert NoSuchAgent();
            if (level > MAX_LEVEL || level == agentLevel[id]) revert BadLevel();
        } else if (op == Op.SetLevelLimits) {
            (uint8 level, uint256 per, uint256 daily) = abi.decode(data, (uint8, uint256, uint256));
            if (level > MAX_LEVEL || per > daily) revert BadLevelLimits();
        } else if (op == Op.SetStructure) {
            if (abi.decode(data, (uint8)) > STRUCTURE_TREE) revert BadRole();
        }
    }

    /// @dev What a change is about, for `_tightenedAt`: one key per rule, payee, agent (cap, level,
    ///      removal), domain, level's limits, plus the threshold and the freeze. 0 = nothing tracked.
    function _subject(Op op, bytes calldata data) internal pure returns (bytes32 key) {
        // Group by op: rules 1, payees 2, agents (cap, removal, level) 3, domains 4, threshold 5,
        // freeze 6, a level's limits 7; 0 for the rest.
        uint256 g = uint8(SUBJECT_GROUPS[uint8(op)]);
        if (g == 0) return 0;
        if (g == 4) key = keccak256(data); // a domain: the string, not its offset
        else if ((g < 5 || g > 6) && data.length >= 32) key = bytes32(data[:32]); // rule id, payee, agent id, level
        return keccak256(abi.encodePacked(key, g));
    }

    function _apply(Op op, bytes memory data, address actor) internal {
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
            _pinHost();
            _removeAddr(_members, _memberIdx, m);
            _teamEpoch++;
            delete roleOf[m];
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
        } else if (op == Op.SetStructure) {
            _setStructure(abi.decode(data, (uint8)), actor); // voted: the proposer becomes Admin
        }
    }

    // ------------------------------------------------------------------ the other half

    /// @notice The code version behind this org's address.
    function version() external pure virtual returns (uint256) {
        return 7;
    }

    /// @dev Everything not above runs in DharmaExt, on this storage, as if it were here.
    fallback() external {
        address e = ext;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), e, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
