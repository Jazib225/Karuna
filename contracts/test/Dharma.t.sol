// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {Dharma} from "../src/Dharma.sol";

contract DharmaTest is Test {
    Dharma dharma;
    address gk = makeAddr("gatekeeper");
    uint256 aliceKey = 0xA11CE;
    uint256 bobKey = 0xB0B;
    uint256 carolKey = 0xCA201;
    uint256 malloryKey = 0xBAD;
    address alice;
    address bob;
    address carol;

    uint64 constant TIMELOCK = 60;
    bytes32 constant AGENT = bytes32("ops-agent");
    address constant PAYEE = address(0xBEEF);

    function setUp() public {
        alice = vm.addr(aliceKey);
        bob = vm.addr(bobKey);
        carol = vm.addr(carolKey);
        string[] memory d = new string[](2);
        d[0] = "github.com";
        d[1] = "stripe.com";
        dharma = new Dharma(gk, alice, TIMELOCK, 500e6, d);
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

    // ------------------------------------------------------------- ROADMAP: tighten is instant

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

    // ------------------------------------------------------------- ROADMAP: loosen is slow + public

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
        vm.expectRevert(abi.encodeWithSelector(Dharma.Invalid.selector, "already voted"));
        dharma.vote(id, true, alice, block.timestamp + 1 hours, sig);
    }

    // ------------------------------------------------------------- ROADMAP: core boundaries

    function test_removing_a_core_boundary_always_fails() public {
        bytes32[4] memory core = [bytes32("core-boundary"), "secrets-read", "unknown-recipient", "default-deny"];
        for (uint256 i; i < core.length; i++) {
            bytes memory data = abi.encode(core[i]);
            // not through the fast path...
            bytes memory tsig = sign(aliceKey, Dharma.Kind.Tighten, Dharma.Op.RemoveRule, data, 0, false);
            vm.prank(gk);
            vm.expectRevert(Dharma.MembersMustPropose.selector);
            dharma.tighten(Dharma.Op.RemoveRule, data, alice, block.timestamp + 1 hours, tsig);
            // ...and not through a vote either
            bytes memory psig = sign(aliceKey, Dharma.Kind.Propose, Dharma.Op.RemoveRule, data, 0, false);
            vm.expectRevert(Dharma.CoreBoundary.selector);
            dharma.propose(Dharma.Op.RemoveRule, data, alice, block.timestamp + 1 hours, psig);
            assertTrue(ruleActive(core[i]));
        }
    }

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
        assertEq(dharma.agentCap(AGENT), 10e6);
        assertTrue(dharma.isTightening(Dharma.Op.SetAgent, abi.encode(AGENT, uint256(5e6))));
        assertFalse(dharma.isTightening(Dharma.Op.SetAgent, abi.encode(AGENT, uint256(20e6))));
        pass(Dharma.Op.SetAgent, abi.encode(AGENT, uint256(5e6))); // lowering is a member edit: a vote
        assertEq(dharma.agentCap(AGENT), 5e6);
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
        vm.expectRevert(abi.encodeWithSelector(Dharma.Invalid.selector, "log cannot shrink"));
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
        vm.expectRevert(abi.encodeWithSelector(Dharma.Invalid.selector, "cannot remove"));
        dharma.propose(Dharma.Op.RemoveMember, data, alice, block.timestamp + 1 hours, sig);
    }
}
