// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {Dharma as DharmaCore} from "../src/Dharma.sol";
import {DharmaBase as Dharma} from "../src/DharmaBase.sol";
import {DharmaExt} from "../src/DharmaExt.sol";
import {DharmaAbi} from "../src/DharmaAbi.sol";
import {DharmaProxy} from "../src/DharmaProxy.sol";

/// Stand-in for a future Dharma version, to test upgrades.
contract DharmaNext is DharmaCore {
    constructor(address ext_) DharmaCore(ext_) {}

    function version() external pure override returns (uint256) {
        return 7;
    }
}

contract DharmaTest is Test {
    DharmaAbi dharma;
    address gk = makeAddr("gatekeeper");
    uint256 aliceKey = 0xA11CE;
    uint256 bobKey = 0xB0B;
    uint256 carolKey = 0xCA201;
    uint256 malloryKey = 0xBAD;
    address alice;
    address bob;
    address carol;

    uint64 constant TIMELOCK = 60;
    uint64 constant CORE = 1 days;
    bytes32 constant AGENT = bytes32("ops-agent");
    address constant PAYEE = address(0xBEEF);

    function setUp() public {
        alice = vm.addr(aliceKey);
        bob = vm.addr(bobKey);
        carol = vm.addr(carolKey);
        string[] memory d = new string[](2);
        d[0] = "github.com";
        d[1] = "stripe.com";
        DharmaCore impl = new DharmaCore(address(new DharmaExt()));
        dharma = DharmaAbi(address(new DharmaProxy(address(impl), abi.encodeCall(DharmaExt.initialize, (gk, alice, TIMELOCK, CORE, 500e6, d)))));
    }

    // ------------------------------------------------------------- helpers

    function sign(uint256 pk, Dharma.Kind kind, Dharma.Op op, bytes memory data, uint256 pid, bool support)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest =
            dharma.actionDigest(kind, op, data, pid, support, dharma.nonces(vm.addr(pk)), block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function tighten(uint256 pk, Dharma.Op op, bytes memory data) internal {
        bytes memory sig = sign(pk, Dharma.Kind.Tighten, op, data, 0, false);
        vm.prank(gk); // the Gatekeeper relays; the member signed
        dharma.tighten(op, data, vm.addr(pk), block.timestamp + 1 hours, sig);
    }

    function propose(uint256 pk, Dharma.Op op, bytes memory data) internal returns (uint256) {
        bytes memory sig = sign(pk, Dharma.Kind.Propose, op, data, 0, false);
        return dharma.propose(op, data, vm.addr(pk), block.timestamp + 1 hours, sig);
    }

    function vote(uint256 pk, uint256 id, bool support) internal {
        Dharma.Proposal memory p = dharma.proposal(id);
        bytes memory sig = sign(pk, Dharma.Kind.Vote, p.op, p.data, id, support);
        dharma.vote(id, support, vm.addr(pk), block.timestamp + 1 hours, sig);
    }

    /// Pass a loosening with the current membership (single member: alice alone is a majority).
    function pass(Dharma.Op op, bytes memory data) internal returns (uint256 id) {
        id = propose(aliceKey, op, data);
        vm.warp(block.timestamp + TIMELOCK);
        dharma.execute(id);
    }

    function manage(uint256 pk, Dharma.Op op, bytes memory data) internal {
        bytes memory sig = sign(pk, Dharma.Kind.Manage, op, data, 0, false);
        dharma.manage(op, data, vm.addr(pk), block.timestamp + 1 hours, sig);
    }

    function expectManageRevert(uint256 pk, Dharma.Op op, bytes memory data, bytes4 err) internal {
        bytes memory sig = sign(pk, Dharma.Kind.Manage, op, data, 0, false);
        vm.expectRevert(err);
        dharma.manage(op, data, vm.addr(pk), block.timestamp + 1 hours, sig);
    }

    /// A tree set up while alice is alone (with others it goes to a vote), then bob and carol join.
    function tree() internal {
        manage(aliceKey, Dharma.Op.SetStructure, abi.encode(uint8(1)));
        addMembers();
    }

    function addMembers() internal {
        pass(Dharma.Op.AddMember, abi.encode(bob)); // 1 member: alice is a majority
        uint256 id = propose(aliceKey, Dharma.Op.AddMember, abi.encode(carol));
        vote(bobKey, id, true); // 2 of 2
        vm.warp(block.timestamp + TIMELOCK);
        dharma.execute(id);
    }

    function blockRule(bytes32 id) internal pure returns (bytes memory) {
        return abi.encode(id, uint8(Dharma.Outcome.Deny), AGENT, "payment:supplies", "", uint256(0));
    }

    function capOf(bytes32 id) internal view returns (uint256) {
        (bytes32[] memory ids, uint256[] memory caps) = dharma.agents();
        for (uint256 i; i < ids.length; i++) if (ids[i] == id) return caps[i];
        return 0;
    }

    function levelOf(bytes32 id) internal view returns (uint8) {
        (bytes32[] memory ids, uint8[] memory lvls) = dharma.levels();
        for (uint256 i; i < ids.length; i++) if (ids[i] == id) return lvls[i];
        return 0;
    }

    function ruleActive(bytes32 id) internal view returns (bool) {
        Dharma.Rule[] memory rs = dharma.rules();
        for (uint256 i; i < rs.length; i++) if (rs[i].id == id) return rs[i].active;
        return false;
    }

    // ------------------------------------------------------------- setup

    function test_starts_with_default_policy_and_one_member() public view {
        assertEq(dharma.gatekeeper(), gk);
        assertEq(dharma.members().length, 1);
        assertTrue(dharma.isMember(alice));
        assertEq(dharma.rules().length, 13);
        assertEq(dharma.domains().length, 2);
        assertEq(dharma.thresholdMicroUsd(), 500e6);
        assertFalse(dharma.frozen());
    }

    // ------------------------------------------------------------- tighten is instant

    function test_a_members_block_rule_goes_to_a_vote() public {
        bytes memory sig = sign(aliceKey, Dharma.Kind.Tighten, Dharma.Op.AddRule, blockRule("no-supplies"), 0, false);
        vm.prank(gk);
        vm.expectRevert(Dharma.MembersMustPropose.selector);
        dharma.tighten(Dharma.Op.AddRule, blockRule("no-supplies"), alice, block.timestamp + 1 hours, sig);

        uint256 id = propose(aliceKey, Dharma.Op.AddRule, blockRule("no-supplies"));
        assertFalse(ruleActive("no-supplies")); // not until the timelock passes
        vm.warp(block.timestamp + TIMELOCK);
        vm.expectEmit(true, false, false, true);
        emit Dharma.RuleAdded(bytes32("no-supplies"), Dharma.Outcome.Deny, AGENT, "payment:supplies", "", 0);
        dharma.execute(id);
        assertTrue(ruleActive("no-supplies"));
    }

    function gkTighten(Dharma.Op op, bytes memory data) internal {
        vm.prank(gk);
        dharma.tighten(op, data, address(0), 0, "");
    }

    function test_gatekeeper_can_tighten_alone_but_never_loosen() public {
        vm.prank(gk);
        dharma.tighten(Dharma.Op.AddRule, blockRule("auto-shield-1"), address(0), 0, "");
        assertTrue(ruleActive("auto-shield-1"));

        vm.prank(gk);
        vm.expectRevert(Dharma.NotTightening.selector);
        dharma.tighten(Dharma.Op.SetPayee, abi.encode(PAYEE, "data"), address(0), 0, "");

        vm.prank(gk);
        vm.expectRevert(Dharma.NotTightening.selector);
        dharma.tighten(
            Dharma.Op.AddRule,
            abi.encode(bytes32("sneaky-allow"), uint8(Dharma.Outcome.Allow), bytes32(0), "payment", "", uint256(0)),
            address(0),
            0,
            ""
        );
    }

    function test_only_the_gatekeeper_may_tighten_without_a_signature() public {
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(Dharma.NotGatekeeper.selector);
        dharma.tighten(Dharma.Op.Freeze, "", address(0), 0, "");
    }

    function test_a_loosening_cannot_be_sent_down_the_fast_path() public {
        bytes memory data = abi.encode(PAYEE, "data");
        bytes memory sig = sign(aliceKey, Dharma.Kind.Tighten, Dharma.Op.SetPayee, data, 0, false);
        vm.prank(gk);
        vm.expectRevert(Dharma.MembersMustPropose.selector);
        dharma.tighten(Dharma.Op.SetPayee, data, alice, block.timestamp + 1 hours, sig);
    }

    function test_a_tightening_can_be_proposed() public {
        uint256 id = propose(aliceKey, Dharma.Op.AddRule, blockRule("x"));
        assertEq(uint8(dharma.proposal(id).status), uint8(Dharma.Status.Queued)); // alice alone is a majority
    }

    // ------------------------------------------------------------- loosen is slow + public

    function test_removing_a_rule_only_works_after_the_vote_and_the_wait() public {
        addMembers(); // alice, bob, carol → 2 of 3 needed
        gkTighten(Dharma.Op.AddRule, blockRule("no-supplies")); // e.g. Auto-Shield's block

        uint256 id = propose(aliceKey, Dharma.Op.RemoveRule, abi.encode(bytes32("no-supplies")));
        assertEq(uint8(dharma.proposal(id).status), uint8(Dharma.Status.Open));

        vm.expectRevert(Dharma.NotReady.selector); // no majority yet
        dharma.execute(id);

        vm.expectEmit(true, false, false, true);
        emit Dharma.ProposalQueued(id, uint64(block.timestamp) + TIMELOCK);
        vote(bobKey, id, true);

        vm.expectRevert(Dharma.NotReady.selector); // majority, but timelock not elapsed
        dharma.execute(id);
        vm.warp(block.timestamp + TIMELOCK - 1);
        vm.expectRevert(Dharma.NotReady.selector);
        dharma.execute(id);

        vm.warp(block.timestamp + 1);
        dharma.execute(id);
        assertFalse(ruleActive("no-supplies"));
        assertEq(uint8(dharma.proposal(id).status), uint8(Dharma.Status.Executed));
    }

    function test_majority_against_defeats_a_proposal() public {
        addMembers();
        uint256 id = propose(aliceKey, Dharma.Op.SetPayee, abi.encode(PAYEE, "data"));
        vote(bobKey, id, false);
        vote(carolKey, id, false);
        assertEq(uint8(dharma.proposal(id).status), uint8(Dharma.Status.Defeated));
        vm.warp(block.timestamp + TIMELOCK);
        vm.expectRevert(Dharma.NotReady.selector);
        dharma.execute(id);
    }

    function test_a_member_votes_once() public {
        addMembers();
        uint256 id = propose(aliceKey, Dharma.Op.AddDomain, abi.encode("pypi.org"));
        Dharma.Proposal memory p = dharma.proposal(id);
        bytes memory sig = sign(aliceKey, Dharma.Kind.Vote, p.op, p.data, id, true);
        vm.expectRevert(Dharma.AlreadyVoted.selector);
        dharma.vote(id, true, alice, block.timestamp + 1 hours, sig);
    }

    // ------------------------------------------------------------- core boundaries

    function test_non_core_default_rules_can_be_removed_by_vote() public {
        pass(Dharma.Op.RemoveRule, abi.encode(bytes32("package-install")));
        assertFalse(ruleActive("package-install"));
        // re-enabling it is a member edit too: a vote
        pass(Dharma.Op.AddRule, abi.encode(bytes32("package-install"), uint8(0), bytes32(0), "", "", uint256(0)));
        assertTrue(ruleActive("package-install"));
    }

    // ------------------------------------------------------------- classification

    function test_allowances_lower_fast_raise_slow() public {
        pass(Dharma.Op.SetAgent, abi.encode(AGENT, uint256(10e6))); // new agent = loosening
        assertEq(capOf(AGENT), 10e6);
        assertTrue(dharma.isTightening(Dharma.Op.SetAgent, abi.encode(AGENT, uint256(5e6))));
        assertFalse(dharma.isTightening(Dharma.Op.SetAgent, abi.encode(AGENT, uint256(20e6))));
        pass(Dharma.Op.SetAgent, abi.encode(AGENT, uint256(5e6))); // lowering is a member edit: a vote
        assertEq(capOf(AGENT), 5e6);
    }

    function test_threshold_lower_fast_raise_slow() public view {
        assertTrue(dharma.isTightening(Dharma.Op.SetThreshold, abi.encode(uint256(100e6))));
        assertFalse(dharma.isTightening(Dharma.Op.SetThreshold, abi.encode(uint256(900e6))));
    }

    function test_payees_add_slow_remove_fast() public {
        pass(Dharma.Op.SetPayee, abi.encode(PAYEE, "data"));
        assertEq(dharma.payees().length, 1);
        assertEq(dharma.payees()[0].category, "data");
        pass(Dharma.Op.RemovePayee, abi.encode(PAYEE));
        assertEq(dharma.payees().length, 0);
    }

    // ------------------------------------------------------------- panic button

    function test_any_member_freezes_instantly_unfreeze_needs_vote() public {
        addMembers();
        vm.expectEmit(true, false, false, false);
        emit Dharma.AgentFrozen(carol);
        tighten(carolKey, Dharma.Op.Freeze, "");
        assertTrue(dharma.frozen());

        uint256 id = propose(carolKey, Dharma.Op.Unfreeze, "");
        vm.warp(block.timestamp + TIMELOCK);
        vm.expectRevert(Dharma.NotReady.selector); // one vote of three is not a majority
        dharma.execute(id);
        vote(aliceKey, id, true);
        vm.warp(block.timestamp + TIMELOCK);
        dharma.execute(id);
        assertFalse(dharma.frozen());
    }

    // ------------------------------------------------------------- signatures

    function test_non_members_cannot_act() public {
        bytes memory sig = sign(malloryKey, Dharma.Kind.Tighten, Dharma.Op.Freeze, "", 0, false);
        vm.expectRevert(Dharma.NotMember.selector);
        dharma.tighten(Dharma.Op.Freeze, "", vm.addr(malloryKey), block.timestamp + 1 hours, sig);
    }

    function test_relayer_cannot_forge_or_alter_a_signed_action() public {
        // alice signs "add payee 0xBEEF"; the relayer swaps in its own address
        bytes memory sig = sign(aliceKey, Dharma.Kind.Propose, Dharma.Op.SetPayee, abi.encode(PAYEE, "data"), 0, false);
        vm.expectRevert(Dharma.BadSignature.selector);
        dharma.propose(Dharma.Op.SetPayee, abi.encode(gk, "data"), alice, block.timestamp + 1 hours, sig);
        // or claims mallory's signature is alice's
        bytes memory msig = sign(malloryKey, Dharma.Kind.Propose, Dharma.Op.SetPayee, abi.encode(PAYEE, "data"), 0, false);
        vm.expectRevert(Dharma.BadSignature.selector);
        dharma.propose(Dharma.Op.SetPayee, abi.encode(PAYEE, "data"), alice, block.timestamp + 1 hours, msig);
    }

    function test_signatures_cannot_be_replayed() public {
        bytes memory sig = sign(aliceKey, Dharma.Kind.Tighten, Dharma.Op.Freeze, "", 0, false);
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(gk);
        dharma.tighten(Dharma.Op.Freeze, "", alice, deadline, sig);
        // the same signed action, submitted again: the nonce moved on, so it no longer verifies
        vm.prank(gk);
        vm.expectRevert(Dharma.BadSignature.selector);
        dharma.tighten(Dharma.Op.Freeze, "", alice, deadline, sig);
    }

    function test_expired_signatures_are_rejected() public {
        uint256 deadline = block.timestamp + 10;
        bytes32 digest = dharma.actionDigest(Dharma.Kind.Tighten, Dharma.Op.Freeze, "", 0, false, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
        vm.warp(deadline + 1);
        vm.expectRevert(Dharma.Expired.selector);
        dharma.tighten(Dharma.Op.Freeze, "", alice, deadline, abi.encodePacked(r, s, v));
    }

    // ------------------------------------------------------------- log anchoring + alerts

    function test_log_anchor_is_gatekeeper_only_and_cannot_rewind() public {
        vm.expectRevert(Dharma.NotGatekeeper.selector);
        dharma.anchorLog(bytes32("h"), 10);
        vm.startPrank(gk);
        dharma.anchorLog(bytes32("h1"), 10);
        dharma.anchorLog(bytes32("h2"), 25);
        vm.expectRevert(Dharma.LogCannotShrink.selector);
        dharma.anchorLog(bytes32("h0"), 5);
        vm.stopPrank();
        assertEq(dharma.logHead(), bytes32("h2"));
        assertEq(dharma.logLength(), 25);
    }

    function test_alert_events_are_gatekeeper_only() public {
        vm.expectRevert(Dharma.NotGatekeeper.selector);
        dharma.requestApproval(bytes32("p"), AGENT, 900e6, bytes32("hash"));
        vm.prank(gk);
        vm.expectEmit(true, true, false, true);
        emit Dharma.ApprovalRequested(bytes32("p"), AGENT, 900e6, bytes32("hash"));
        dharma.requestApproval(bytes32("p"), AGENT, 900e6, bytes32("hash"));
    }

    function test_the_last_member_cannot_be_removed() public {
        bytes memory data = abi.encode(alice);
        bytes memory sig = sign(aliceKey, Dharma.Kind.Propose, Dharma.Op.RemoveMember, data, 0, false);
        vm.expectRevert(Dharma.CannotRemove.selector);
        dharma.propose(Dharma.Op.RemoveMember, data, alice, block.timestamp + 1 hours, sig);
    }

    // ------------------------------------------------------------- v2: proxy + setup

    function test_runs_behind_a_proxy_that_nobody_can_reinitialize() public {
        assertEq(dharma.version(), 6);
        assertEq(dharma.timelock(), TIMELOCK);
        assertEq(dharma.coreTimelock(), CORE);
        string[] memory d = new string[](0);
        vm.expectRevert(Dharma.AlreadyInitialized.selector);
        dharma.initialize(makeAddr("evil"), makeAddr("evil"), 0, CORE, 0, d);
        // the bare implementation can't be initialized either
        DharmaAbi impl = DharmaAbi(dharma.implementation());
        vm.expectRevert(Dharma.AlreadyInitialized.selector);
        impl.initialize(makeAddr("evil"), makeAddr("evil"), 0, CORE, 0, d);
    }

    function test_setup_rejects_bad_waits() public {
        DharmaCore impl = new DharmaCore(address(new DharmaExt()));
        string[] memory d = new string[](0);
        vm.expectRevert(Dharma.BadCoreWait.selector);
        new DharmaProxy(address(impl), abi.encodeCall(DharmaExt.initialize, (gk, alice, TIMELOCK, 0, 500e6, d)));
        vm.expectRevert(Dharma.WaitTooLong.selector);
        new DharmaProxy(address(impl), abi.encodeCall(DharmaExt.initialize, (gk, alice, 8 days, CORE, 500e6, d)));
    }

    // ------------------------------------------------------------- v2: core rules change only by everyone + the core wait

    function test_core_rules_cannot_be_removed_on_the_fast_path() public {
        bytes memory data = abi.encode(bytes32("secrets-read"));
        bytes memory sig = sign(aliceKey, Dharma.Kind.Tighten, Dharma.Op.RemoveRule, data, 0, false);
        vm.prank(gk);
        vm.expectRevert(Dharma.MembersMustPropose.selector);
        dharma.tighten(Dharma.Op.RemoveRule, data, alice, block.timestamp + 1 hours, sig);
        vm.prank(gk);
        vm.expectRevert(Dharma.NotTightening.selector); // and the Gatekeeper can't either
        dharma.tighten(Dharma.Op.RemoveRule, data, address(0), 0, "");
    }

    function test_a_majority_cannot_remove_a_core_rule_but_everyone_can_after_the_core_wait() public {
        addMembers(); // alice, bob, carol
        bytes memory data = abi.encode(bytes32("secrets-read"));
        assertTrue(dharma.isCoreChange(Dharma.Op.RemoveRule, data));
        uint256 id = propose(aliceKey, Dharma.Op.RemoveRule, data);
        assertTrue(dharma.proposal(id).core);
        assertEq(dharma.requiredFor(id), 3);
        vote(bobKey, id, true); // 2 of 3: a majority, not enough for a core change
        assertEq(uint8(dharma.proposal(id).status), uint8(Dharma.Status.Open));
        vm.warp(block.timestamp + CORE);
        vm.expectRevert(Dharma.NotReady.selector);
        dharma.execute(id);

        vote(carolKey, id, true); // everyone: passes, and still waits the full core wait (no skip)
        assertEq(dharma.proposal(id).eta, uint64(block.timestamp) + CORE);
        vm.warp(block.timestamp + CORE - 1);
        vm.expectRevert(Dharma.NotReady.selector);
        dharma.execute(id);
        vm.warp(block.timestamp + 1);
        dharma.execute(id);
        assertFalse(ruleActive("secrets-read"));
    }

    function test_one_no_vote_defeats_a_core_change() public {
        addMembers();
        uint256 id = propose(aliceKey, Dharma.Op.RemoveRule, abi.encode(bytes32("default-deny")));
        vote(bobKey, id, false);
        assertEq(uint8(dharma.proposal(id).status), uint8(Dharma.Status.Defeated));
    }

    function test_a_freeze_cancels_pending_core_changes_but_not_normal_ones() public {
        addMembers();
        uint256 open = propose(aliceKey, Dharma.Op.RemoveRule, abi.encode(bytes32("secrets-read"))); // core, still voting
        uint256 queued = propose(aliceKey, Dharma.Op.SetCoreTimelock, abi.encode(uint64(2 days))); // core, passed
        vote(bobKey, queued, true);
        vote(carolKey, queued, true);
        uint256 normal = propose(aliceKey, Dharma.Op.AddDomain, abi.encode("pypi.org"));
        vote(bobKey, normal, true);

        vm.expectEmit(true, false, false, false);
        emit Dharma.ProposalCancelled(open);
        tighten(bobKey, Dharma.Op.Freeze, "");
        assertEq(uint8(dharma.proposal(open).status), uint8(Dharma.Status.Cancelled));
        assertEq(uint8(dharma.proposal(queued).status), uint8(Dharma.Status.Cancelled));
        assertEq(uint8(dharma.proposal(normal).status), uint8(Dharma.Status.Queued));
        vm.warp(block.timestamp + CORE);
        vm.expectRevert(Dharma.NotReady.selector);
        dharma.execute(queued);
        dharma.execute(normal);
    }

    // ------------------------------------------------------------- v2: every member can skip the wait (normal changes)

    function test_everyone_voting_yes_skips_the_wait_for_a_normal_change() public {
        addMembers();
        uint256 id = propose(aliceKey, Dharma.Op.AddDomain, abi.encode("pypi.org"));
        vote(bobKey, id, true); // majority: queued with the normal wait
        assertEq(dharma.proposal(id).eta, uint64(block.timestamp) + TIMELOCK);
        vm.expectRevert(Dharma.NotReady.selector);
        dharma.execute(id);
        vm.expectEmit(true, false, false, false);
        emit Dharma.WaitSkipped(id);
        vote(carolKey, id, true); // the last member: applies now
        dharma.execute(id);
        assertEq(dharma.domains().length, 3);
    }

    function test_the_skip_never_applies_to_unfreeze_core_changes_or_a_solo_member() public {
        // solo: one member's yes is "everyone", but a skip needs a team
        uint256 solo = propose(aliceKey, Dharma.Op.AddDomain, abi.encode("pypi.org"));
        assertEq(dharma.proposal(solo).eta, uint64(block.timestamp) + TIMELOCK);

        addMembers();
        tighten(aliceKey, Dharma.Op.Freeze, "");
        uint256 unfreeze = propose(aliceKey, Dharma.Op.Unfreeze, "");
        vote(bobKey, unfreeze, true); // passed: waits the normal wait
        // there is no skip for Unfreeze, so a further yes has nothing to do: refused
        Dharma.Proposal memory p = dharma.proposal(unfreeze);
        bytes memory sig = sign(carolKey, Dharma.Kind.Vote, p.op, p.data, unfreeze, true);
        vm.expectRevert(Dharma.VotingClosed.selector);
        dharma.vote(unfreeze, true, carol, vm.getBlockTimestamp() + 1 hours, sig);
        assertEq(dharma.proposal(unfreeze).eta, uint64(vm.getBlockTimestamp()) + TIMELOCK);
        vm.expectRevert(Dharma.NotReady.selector);
        dharma.execute(unfreeze);
    }

    function test_no_votes_after_a_proposal_passes_are_refused() public {
        addMembers();
        uint256 id = propose(aliceKey, Dharma.Op.AddDomain, abi.encode("pypi.org"));
        vote(bobKey, id, true);
        Dharma.Proposal memory p = dharma.proposal(id);
        bytes memory sig = sign(carolKey, Dharma.Kind.Vote, p.op, p.data, id, false);
        vm.expectRevert(Dharma.VotingClosed.selector);
        dharma.vote(id, false, carol, block.timestamp + 1 hours, sig);
    }

    // ------------------------------------------------------------- v2: the waits are settings

    function test_the_normal_wait_is_a_normal_change_within_limits() public {
        assertFalse(dharma.isCoreChange(Dharma.Op.SetTimelock, abi.encode(uint64(0))));
        bytes memory tooLong = abi.encode(uint64(8 days));
        bytes memory sig = sign(aliceKey, Dharma.Kind.Propose, Dharma.Op.SetTimelock, tooLong, 0, false);
        vm.expectRevert(Dharma.WaitTooLong.selector);
        dharma.propose(Dharma.Op.SetTimelock, tooLong, alice, block.timestamp + 1 hours, sig);
        pass(Dharma.Op.SetTimelock, abi.encode(uint64(0))); // a team may choose no wait
        assertEq(dharma.timelock(), 0);
        uint256 id = propose(aliceKey, Dharma.Op.AddDomain, abi.encode("pypi.org"));
        dharma.execute(id); // no wait now
    }

    function test_a_changed_wait_never_moves_a_proposal_already_waiting() public {
        uint256 early = propose(aliceKey, Dharma.Op.AddDomain, abi.encode("pypi.org")); // eta: +60s
        uint64 earlyEta = dharma.proposal(early).eta;
        uint256 longer = propose(aliceKey, Dharma.Op.SetTimelock, abi.encode(uint64(1 hours)));
        vm.warp(block.timestamp + TIMELOCK);
        dharma.execute(longer);
        assertEq(dharma.proposal(early).eta, earlyEta);
        dharma.execute(early); // still on its old schedule
        uint256 later = propose(aliceKey, Dharma.Op.AddDomain, abi.encode("npmjs.com"));
        assertEq(dharma.proposal(later).eta, uint64(block.timestamp) + 1 hours);
    }

    function test_the_core_wait_is_a_core_change_within_limits() public {
        assertTrue(dharma.isCoreChange(Dharma.Op.SetCoreTimelock, abi.encode(uint64(2 days))));
        bytes memory tooShort = abi.encode(uint64(59));
        bytes memory sig = sign(aliceKey, Dharma.Kind.Propose, Dharma.Op.SetCoreTimelock, tooShort, 0, false);
        vm.expectRevert(Dharma.BadCoreWait.selector);
        dharma.propose(Dharma.Op.SetCoreTimelock, tooShort, alice, block.timestamp + 1 hours, sig);
        uint256 id = propose(aliceKey, Dharma.Op.SetCoreTimelock, abi.encode(uint64(60)));
        vm.warp(block.timestamp + TIMELOCK); // the normal wait isn't enough: lowering it waits the current core wait
        vm.expectRevert(Dharma.NotReady.selector);
        dharma.execute(id);
        vm.warp(block.timestamp + CORE);
        dharma.execute(id);
        assertEq(dharma.coreTimelock(), 60);
    }

    // ------------------------------------------------------------- v2: upgrades

    function test_an_upgrade_needs_everyone_and_the_core_wait_and_keeps_the_org() public {
        addMembers();
        pass3(Dharma.Op.SetPayee, abi.encode(PAYEE, "data"));
        address next = address(new DharmaNext(address(new DharmaExt())));
        bytes32 domainBefore = dharma.DOMAIN_SEPARATOR();
        uint256 id = propose(aliceKey, Dharma.Op.Upgrade, abi.encode(next));
        assertTrue(dharma.proposal(id).core);
        vote(bobKey, id, true);
        assertEq(uint8(dharma.proposal(id).status), uint8(Dharma.Status.Open)); // a majority can't upgrade
        vote(carolKey, id, true);
        vm.warp(block.timestamp + CORE);
        dharma.execute(id);

        assertEq(dharma.implementation(), next);
        assertEq(dharma.version(), 7);
        // same address, same org: members, rules, payees and signatures all carry over
        assertEq(dharma.members().length, 3);
        assertEq(dharma.rules().length, 13);
        assertEq(dharma.payees().length, 1);
        assertEq(dharma.DOMAIN_SEPARATOR(), domainBefore);
    }

    function test_an_upgrade_must_point_at_real_code() public {
        bytes memory data = abi.encode(makeAddr("not-a-contract"));
        bytes memory sig = sign(aliceKey, Dharma.Kind.Propose, Dharma.Op.Upgrade, data, 0, false);
        vm.expectRevert(Dharma.BadImplementation.selector);
        dharma.propose(Dharma.Op.Upgrade, data, alice, block.timestamp + 1 hours, sig);
    }

    /// Pass a normal change with alice, bob and carol all voting yes (applies now).
    function pass3(Dharma.Op op, bytes memory data) internal {
        uint256 id = propose(aliceKey, op, data);
        vote(bobKey, id, true);
        vote(carolKey, id, true);
        dharma.execute(id);
    }

    // ------------------------------------------------------------- v3: trust levels

    function lvl(bytes32 agent, uint8 level, string memory reason) internal pure returns (bytes memory) {
        return abi.encode(agent, level, reason);
    }

    function withAgent() internal {
        pass(Dharma.Op.SetAgent, abi.encode(AGENT, uint256(0)));
    }

    function test_agents_start_at_level_0_with_default_limits() public {
        withAgent();
        assertEq(levelOf(AGENT), 0);
        Dharma.LevelLimits memory l0 = dharma.levelLimits(0);
        assertEq(l0.perPaymentMicroUsd, 0.1e6);
        assertEq(l0.dailyMicroUsd, 1e6);
        assertEq(dharma.levelLimits(3).dailyMicroUsd, 50e6);
        (bytes32[] memory ids, uint8[] memory ls) = dharma.levels();
        assertEq(ids.length, 1);
        assertEq(ls[0], 0);
        vm.expectRevert(Dharma.BadLevel.selector);
        dharma.levelLimits(4);
    }

    function test_raising_a_level_needs_a_vote_and_the_wait() public {
        withAgent();
        bytes memory up = lvl(AGENT, 2, "vote");
        assertFalse(dharma.isTightening(Dharma.Op.SetLevel, up));
        bytes memory sig = sign(aliceKey, Dharma.Kind.Tighten, Dharma.Op.SetLevel, up, 0, false);
        vm.prank(gk);
        vm.expectRevert(Dharma.NotTightening.selector);
        dharma.tighten(Dharma.Op.SetLevel, up, alice, block.timestamp + 1 hours, sig);
        vm.prank(gk);
        vm.expectRevert(Dharma.NotTightening.selector); // nor the Gatekeeper
        dharma.tighten(Dharma.Op.SetLevel, up, address(0), 0, "");

        uint256 id = propose(aliceKey, Dharma.Op.SetLevel, up);
        assertEq(levelOf(AGENT), 0);
        vm.warp(block.timestamp + TIMELOCK);
        vm.expectEmit(true, true, false, true);
        emit Dharma.LevelSet(AGENT, 2, alice, "vote");
        dharma.execute(id);
        assertEq(levelOf(AGENT), 2);
    }

    function test_any_member_or_the_gatekeeper_lowers_a_level_instantly() public {
        withAgent();
        pass(Dharma.Op.SetLevel, lvl(AGENT, 3, "vote"));
        addMembers();
        tighten(bobKey, Dharma.Op.SetLevel, lvl(AGENT, 2, "member")); // one member, no vote
        assertEq(levelOf(AGENT), 2);
        vm.expectEmit(true, true, false, true);
        emit Dharma.LevelSet(AGENT, 0, gk, "tripwire");
        gkTighten(Dharma.Op.SetLevel, lvl(AGENT, 0, "tripwire"));
        assertEq(levelOf(AGENT), 0);
    }

    function test_levels_are_validated() public {
        bytes memory noAgent = lvl(AGENT, 1, "vote");
        bytes memory sig = sign(aliceKey, Dharma.Kind.Propose, Dharma.Op.SetLevel, noAgent, 0, false);
        vm.expectRevert(Dharma.NoSuchAgent.selector);
        dharma.propose(Dharma.Op.SetLevel, noAgent, alice, block.timestamp + 1 hours, sig);
        withAgent();
        bytes memory tooHigh = lvl(AGENT, 4, "vote");
        sig = sign(aliceKey, Dharma.Kind.Propose, Dharma.Op.SetLevel, tooHigh, 0, false);
        vm.expectRevert(Dharma.BadLevel.selector);
        dharma.propose(Dharma.Op.SetLevel, tooHigh, alice, vm.getBlockTimestamp() + 1 hours, sig);
        bytes memory same = lvl(AGENT, 0, "member");
        vm.prank(gk);
        vm.expectRevert(Dharma.NotTightening.selector); // already 0: nothing to lower
        dharma.tighten(Dharma.Op.SetLevel, same, address(0), 0, "");
    }

    function test_level_limits_lower_fast_raise_slow() public {
        bytes memory lower = abi.encode(uint8(1), uint256(0.2e6), uint256(2e6));
        bytes memory raise = abi.encode(uint8(1), uint256(1e6), uint256(10e6));
        assertTrue(dharma.isTightening(Dharma.Op.SetLevelLimits, lower));
        assertFalse(dharma.isTightening(Dharma.Op.SetLevelLimits, raise));
        gkTighten(Dharma.Op.SetLevelLimits, lower);
        assertEq(dharma.levelLimits(1).dailyMicroUsd, 2e6);
        // a member's lower still goes to a vote (only Freeze and level drops are instant for members)
        bytes memory sig = sign(aliceKey, Dharma.Kind.Tighten, Dharma.Op.SetLevelLimits, lower, 0, false);
        vm.prank(gk);
        vm.expectRevert(Dharma.MembersMustPropose.selector);
        dharma.tighten(Dharma.Op.SetLevelLimits, lower, alice, block.timestamp + 1 hours, sig);
        bytes memory bad = abi.encode(uint8(1), uint256(5e6), uint256(1e6));
        sig = sign(aliceKey, Dharma.Kind.Propose, Dharma.Op.SetLevelLimits, bad, 0, false);
        vm.expectRevert(Dharma.BadLevelLimits.selector);
        dharma.propose(Dharma.Op.SetLevelLimits, bad, alice, block.timestamp + 1 hours, sig);
        pass(Dharma.Op.SetLevelLimits, raise);
        assertEq(dharma.levelLimits(1).perPaymentMicroUsd, 1e6);
    }

    function test_removing_an_agent_clears_its_level() public {
        withAgent();
        pass(Dharma.Op.SetLevel, lvl(AGENT, 2, "vote"));
        gkTighten(Dharma.Op.RemoveAgent, abi.encode(AGENT));
        assertEq(levelOf(AGENT), 0);
    }

    function test_the_record_is_anchored_with_the_log_by_the_gatekeeper_only() public {
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = AGENT;
        ids[1] = bytes32("research");
        uint64[] memory done = new uint64[](2);
        done[0] = 12;
        done[1] = 3;
        uint64[] memory denied = new uint64[](2);
        denied[1] = 1;
        vm.expectRevert(Dharma.NotGatekeeper.selector);
        dharma.anchorWithRecord(bytes32("h"), 10, ids, done, denied);
        vm.prank(gk);
        vm.expectEmit(true, false, false, true);
        emit Dharma.ActionsRecorded(AGENT, 12, 0);
        dharma.anchorWithRecord(bytes32("h"), 10, ids, done, denied);
        assertEq(dharma.logLength(), 10);
        vm.prank(gk);
        vm.expectRevert(Dharma.LogCannotShrink.selector);
        dharma.anchorWithRecord(bytes32("h0"), 5, ids, done, denied);
        uint64[] memory short = new uint64[](1);
        vm.prank(gk);
        vm.expectRevert(Dharma.LengthMismatch.selector);
        dharma.anchorWithRecord(bytes32("h2"), 11, ids, short, denied);
    }

    function test_tripwires_are_reported_per_agent_by_the_gatekeeper_only() public {
        vm.expectRevert(Dharma.NotGatekeeper.selector);
        dharma.reportTripwire(AGENT, "trap password");
        vm.prank(gk);
        vm.expectEmit(true, false, false, true);
        emit Dharma.TripwireFired(AGENT, "trap password");
        dharma.reportTripwire(AGENT, "trap password");
    }

    function test_unapproved_transfers_are_reported_by_the_gatekeeper_only() public {
        vm.expectRevert(Dharma.NotGatekeeper.selector);
        dharma.reportUnapprovedTransfer(bytes32("tx"), PAYEE, 5e6);
        vm.prank(gk);
        vm.expectEmit(true, true, false, true);
        emit Dharma.UnapprovedTransfer(bytes32("tx"), PAYEE, 5e6);
        dharma.reportUnapprovedTransfer(bytes32("tx"), PAYEE, 5e6);
    }

    // ------------------------------------------------------------- team roles (v4)

    function test_a_new_org_is_flat_and_every_member_can_do_everything() public {
        addMembers();
        assertEq(dharma.structure(), 0);
        assertEq(dharma.permissionsOf(bob), 127);
        assertEq(dharma.permissionsOf(mallory()), 0);
        tighten(bobKey, Dharma.Op.Freeze, "");
        assertTrue(dharma.frozen());
    }

    function test_a_tree_makes_its_creator_admin_and_everyone_else_a_member() public {
        tree();
        assertEq(dharma.structure(), 1);
        assertEq(dharma.roleOf(alice), 1);
        assertEq(dharma.permissionsOf(alice), 127);
        assertEq(dharma.permissionsOf(bob), 15); // approve, cancel escrow, propose, agents

        bytes memory sig = sign(bobKey, Dharma.Kind.Tighten, Dharma.Op.Freeze, "", 0, false);
        vm.prank(gk);
        vm.expectRevert(Dharma.NoPermission.selector);
        dharma.tighten(Dharma.Op.Freeze, "", bob, block.timestamp + 1 hours, sig);

        expectManageRevert(bobKey, Dharma.Op.SetRole, abi.encode(bob, uint8(1)), Dharma.NoPermission.selector);
        propose(bobKey, Dharma.Op.AddDomain, abi.encode("example.com")); // members still propose
    }

    function test_roles_never_stop_a_member_from_voting() public {
        tree();
        manage(aliceKey, Dharma.Op.SetRolePerms, abi.encode(uint8(3), uint16(1))); // approve only
        manage(aliceKey, Dharma.Op.SetRole, abi.encode(carol, uint8(3)));
        assertEq(dharma.permissionsOf(carol), 1);

        bytes memory sig = sign(carolKey, Dharma.Kind.Propose, Dharma.Op.AddDomain, abi.encode("example.com"), 0, false);
        vm.expectRevert(Dharma.NoPermission.selector);
        dharma.propose(Dharma.Op.AddDomain, abi.encode("example.com"), carol, block.timestamp + 1 hours, sig);

        uint256 id = propose(aliceKey, Dharma.Op.AddDomain, abi.encode("example.com"));
        vote(carolKey, id, true);
        assertTrue(dharma.hasVoted(id, carol));
    }

    function test_deleting_a_custom_role_falls_back_to_the_default() public {
        tree();
        manage(aliceKey, Dharma.Op.SetRolePerms, abi.encode(uint8(3), uint16(64))); // freeze only
        manage(aliceKey, Dharma.Op.SetRole, abi.encode(carol, uint8(3)));
        assertEq(dharma.permissionsOf(carol), 64);
        assertEq((dharma.rolePerms() >> 48) & 0xffff, 64 | 0x4000);

        manage(aliceKey, Dharma.Op.SetRolePerms, abi.encode(uint8(3), uint16(0x8000)));
        assertEq(dharma.permissionsOf(carol), 15);
        assertEq((dharma.rolePerms() >> 48) & 0xffff, 0);

        expectManageRevert(aliceKey, Dharma.Op.SetRole, abi.encode(carol, uint8(4)), Dharma.BadRole.selector);
        expectManageRevert(aliceKey, Dharma.Op.SetRolePerms, abi.encode(uint8(2), uint16(0x8000)), Dharma.BadRole.selector);
        expectManageRevert(aliceKey, Dharma.Op.SetRolePerms, abi.encode(uint8(1), uint16(1)), Dharma.BadRole.selector);
    }

    function test_changing_member_permissions_applies_to_everyone_with_the_default_role() public {
        tree();
        manage(aliceKey, Dharma.Op.SetRolePerms, abi.encode(uint8(2), uint16(15 | 64)));
        assertEq(dharma.permissionsOf(bob), 79);
        tighten(bobKey, Dharma.Op.Freeze, "");
        assertTrue(dharma.frozen());
    }

    function test_someone_always_keeps_team_access() public {
        tree();
        manage(aliceKey, Dharma.Op.SetRole, abi.encode(alice, uint8(2))); // the only Admin steps down
        assertEq(dharma.permissionsOf(alice), 127); // first member, nobody else has "team"
        manage(aliceKey, Dharma.Op.SetRole, abi.encode(bob, uint8(1)));
        assertEq(dharma.permissionsOf(alice), 15);
    }

    function test_role_changes_only_go_through_manage() public {
        bytes memory data = abi.encode(uint8(1));
        bytes memory roleData = abi.encode(bob, uint8(1));
        bytes memory sig = sign(aliceKey, Dharma.Kind.Propose, Dharma.Op.SetRole, roleData, 0, false);
        vm.expectRevert(Dharma.BadRole.selector);
        dharma.propose(Dharma.Op.SetRole, roleData, alice, block.timestamp + 1 hours, sig);

        expectManageRevert(aliceKey, Dharma.Op.AddDomain, abi.encode("example.com"), Dharma.BadRole.selector);
        expectManageRevert(malloryKey, Dharma.Op.SetStructure, data, Dharma.NotMember.selector);
    }

    function test_removing_a_member_clears_their_role() public {
        tree();
        manage(aliceKey, Dharma.Op.SetRole, abi.encode(carol, uint8(1)));
        uint256 id = propose(aliceKey, Dharma.Op.RemoveMember, abi.encode(carol));
        vote(bobKey, id, true);
        vm.warp(block.timestamp + CORE); // removing a member waits the core wait
        dharma.execute(id);
        assertEq(dharma.roleOf(carol), 0);
    }

    // ------------------------------------------------------------- v5 fixes

    function test_a_queued_raise_is_cancelled_by_a_later_instant_drop() public {
        pass(Dharma.Op.SetAgent, abi.encode(AGENT, uint256(10e6)));
        pass(Dharma.Op.SetLevel, lvl(AGENT, 1, "member"));
        uint256 id = propose(aliceKey, Dharma.Op.SetLevel, lvl(AGENT, 2, "member")); // queued for the wait
        vm.warp(block.timestamp + 10);
        gkTighten(Dharma.Op.SetLevel, lvl(AGENT, 0, "tripwire"));
        vm.warp(block.timestamp + TIMELOCK);
        dharma.execute(id); // anyone (the Gatekeeper's executeReady) runs it: it cancels
        assertEq(uint8(dharma.proposal(id).status), uint8(Dharma.Status.Cancelled));
        assertEq(levelOf(AGENT), 0); // raising it again needs a new vote

        uint256 again = propose(aliceKey, Dharma.Op.SetLevel, lvl(AGENT, 1, "member")); // made after the drop
        vm.warp(block.timestamp + TIMELOCK);
        dharma.execute(again);
        assertEq(levelOf(AGENT), 1);
    }

    function test_a_loosening_voted_before_a_tightening_never_undoes_it() public {
        pass(Dharma.Op.SetAgent, abi.encode(AGENT, uint256(10e6)));
        uint256 raise = propose(aliceKey, Dharma.Op.SetAgent, abi.encode(AGENT, uint256(50e6))); // queued
        uint256 tighter = propose(aliceKey, Dharma.Op.SetAgent, abi.encode(AGENT, uint256(1e6))); // voted cut, queued
        vm.warp(block.timestamp + 10);
        gkTighten(Dharma.Op.SetAgent, abi.encode(AGENT, uint256(2e6))); // e.g. an instant cap cut
        vm.warp(block.timestamp + TIMELOCK);
        dharma.execute(raise);
        assertEq(uint8(dharma.proposal(raise).status), uint8(Dharma.Status.Cancelled));
        assertEq(capOf(AGENT), 2e6);
        dharma.execute(tighter); // still a tightening today: it applies
        assertEq(capOf(AGENT), 1e6);
    }

    function test_a_leftover_unfreeze_cant_lift_a_later_freeze() public {
        addMembers();
        tighten(carolKey, Dharma.Op.Freeze, "");
        uint256 first = propose(aliceKey, Dharma.Op.Unfreeze, "");
        uint256 leftover = propose(bobKey, Dharma.Op.Unfreeze, "");
        vote(bobKey, first, true);
        vote(aliceKey, leftover, true);
        vm.warp(block.timestamp + TIMELOCK);
        dharma.execute(first);
        assertFalse(dharma.frozen());
        vm.warp(block.timestamp + 1);
        tighten(carolKey, Dharma.Op.Freeze, ""); // the panic button again
        dharma.execute(leftover);
        assertTrue(dharma.frozen());
        assertEq(uint8(dharma.proposal(leftover).status), uint8(Dharma.Status.Cancelled));
    }

    function test_the_gatekeeper_adds_blocks_and_one_agents_approval_rules_never_org_wide_ones() public {
        bytes memory approvalRule = abi.encode(bytes32("ask-http"), uint8(Dharma.Outcome.Approval), bytes32(0), "http", "", uint256(0));
        assertFalse(dharma.isTightening(Dharma.Op.AddRule, approvalRule));
        vm.prank(gk);
        vm.expectRevert(Dharma.NotTightening.selector);
        dharma.tighten(Dharma.Op.AddRule, approvalRule, address(0), 0, "");
        bytes memory setting = abi.encode(bytes32("set-drills"), uint8(Dharma.Outcome.Approval), bytes32(0), "setting:drillsPerDay", "0", uint256(0));
        vm.prank(gk);
        vm.expectRevert(Dharma.NotTightening.selector);
        dharma.tighten(Dharma.Op.AddRule, setting, address(0), 0, "");
        gkTighten(Dharma.Op.AddRule, blockRule("no-supplies")); // a block still applies at once
        assertTrue(ruleActive("no-supplies"));
        // One agent's approval rule (a pre-flight fix) applies at once too.
        gkTighten(Dharma.Op.AddRule, abi.encode(bytes32("pf-sh"), uint8(Dharma.Outcome.Approval), AGENT, "shell", "", uint256(0)));
        assertTrue(ruleActive("pf-sh"));
    }

    function test_removing_a_member_needs_everyone_else_and_the_core_wait() public {
        addMembers();
        address dave = makeAddr("dave");
        uint256 add = propose(aliceKey, Dharma.Op.AddMember, abi.encode(dave));
        vote(bobKey, add, true);
        vm.warp(block.timestamp + TIMELOCK);
        dharma.execute(add); // 4 members
        uint256 id = propose(aliceKey, Dharma.Op.RemoveMember, abi.encode(carol));
        vote(bobKey, id, true);
        assertEq(uint8(dharma.proposal(id).status), uint8(Dharma.Status.Open)); // a majority (3) isn't enough...
        assertEq(dharma.requiredFor(id), 3);
        uint256 id2 = propose(aliceKey, Dharma.Op.RemoveMember, abi.encode(dave));
        vote(bobKey, id2, true);
        vote(carolKey, id2, true); // everyone but dave
        assertEq(uint8(dharma.proposal(id2).status), uint8(Dharma.Status.Queued));
        vm.warp(block.timestamp + TIMELOCK);
        vm.expectRevert(Dharma.NotReady.selector); // ...and it waits the core wait, not the normal one
        dharma.execute(id2);
        vm.warp(block.timestamp + CORE);
        dharma.execute(id2);
        assertFalse(dharma.isMember(dave));
    }

    function test_a_proposal_left_open_across_a_team_change_is_cancelled() public {
        addMembers(); // alice, bob, carol
        uint256 id = propose(aliceKey, Dharma.Op.SetPayee, abi.encode(PAYEE, "data")); // 1 of 2
        uint256 rm = propose(aliceKey, Dharma.Op.RemoveMember, abi.encode(carol));
        vote(bobKey, rm, true);
        vm.warp(block.timestamp + CORE);
        dharma.execute(rm); // the team is now alice and bob
        vote(bobKey, id, false); // its votes were cast by another team: cancelled, not counted
        assertEq(uint8(dharma.proposal(id).status), uint8(Dharma.Status.Cancelled));
        assertFalse(dharma.hasVoted(id, bob));
    }

    function test_one_member_cant_make_a_flat_team_a_tree_alone() public {
        addMembers();
        expectManageRevert(aliceKey, Dharma.Op.SetStructure, abi.encode(uint8(1)), Dharma.MembersMustPropose.selector);
        pass3(Dharma.Op.SetStructure, abi.encode(uint8(1))); // voted: the proposer becomes Admin
        assertEq(dharma.structure(), 1);
        assertEq(dharma.roleOf(alice), 1);
        manage(aliceKey, Dharma.Op.SetStructure, abi.encode(uint8(0))); // back to flat (everyone gains): at once
        assertEq(dharma.structure(), 0);
    }

    function test_deleting_a_role_takes_it_from_its_holders() public {
        tree();
        manage(aliceKey, Dharma.Op.SetRolePerms, abi.encode(uint8(3), uint16(1)));
        manage(aliceKey, Dharma.Op.SetRole, abi.encode(bob, uint8(3)));
        manage(aliceKey, Dharma.Op.SetRolePerms, abi.encode(uint8(3), uint16(0x8000))); // delete
        assertEq(dharma.roleOf(bob), 0);
        manage(aliceKey, Dharma.Op.SetRolePerms, abi.encode(uint8(3), uint16(127))); // same id, made again
        assertEq(dharma.roleOf(bob), 0);
        assertEq(dharma.permissionsOf(bob) & 16, 0); // no "team" for bob
    }

    function test_isPayee() public {
        assertFalse(dharma.isPayee(PAYEE));
        pass(Dharma.Op.SetPayee, abi.encode(PAYEE, "data"));
        assertTrue(dharma.isPayee(PAYEE));
    }

    function mallory() internal view returns (address) {
        return vm.addr(malloryKey);
    }
}
