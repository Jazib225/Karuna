// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Dharma as DharmaCore} from "../src/Dharma.sol";
import {DharmaBase as Dharma} from "../src/DharmaBase.sol";
import {DharmaExt} from "../src/DharmaExt.sol";
import {DharmaAbi} from "../src/DharmaAbi.sol";
import {DharmaProxy} from "../src/DharmaProxy.sol";
import {DharmaV5} from "./fixtures/DharmaV5.sol";

/// v7: the host (the member who set the org up) removes a teammate without a vote. Never instantly:
/// it waits the core wait in public, can't start while frozen, and any member's Freeze cancels it.
contract HostTest is Test {
    DharmaAbi dharma;
    address gk = makeAddr("gatekeeper");
    uint256 aliceKey = 0xA11CE;
    uint256 bobKey = 0xB0B;
    uint256 carolKey = 0xCA201;
    address alice;
    address bob;
    address carol;

    uint64 constant TIMELOCK = 60;
    uint64 constant CORE = 1 days;

    function nowTs() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function setUp() public {
        alice = vm.addr(aliceKey);
        bob = vm.addr(bobKey);
        carol = vm.addr(carolKey);
        dharma = DharmaAbi(address(new DharmaProxy(address(v7()), abi.encodeCall(DharmaExt.initialize, (gk, alice, TIMELOCK, CORE, 500e6, domains())))));
    }

    // ------------------------------------------------------------- helpers

    function v7() internal returns (DharmaCore) {
        return new DharmaCore(address(new DharmaExt()));
    }

    function domains() internal pure returns (string[] memory d) {
        d = new string[](1);
        d[0] = "github.com";
    }

    function sign(uint256 pk, Dharma.Kind kind, Dharma.Op op, bytes memory data, uint256 pid, bool support) internal view returns (bytes memory) {
        bytes32 digest = dharma.actionDigest(kind, op, data, pid, support, dharma.nonces(vm.addr(pk)), nowTs() + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function propose(uint256 pk, Dharma.Op op, bytes memory data) internal returns (uint256) {
        bytes memory sig = sign(pk, Dharma.Kind.Propose, op, data, 0, false);
        return dharma.propose(op, data, vm.addr(pk), nowTs() + 1 hours, sig);
    }

    function vote(uint256 pk, uint256 id, bool support) internal {
        Dharma.Proposal memory p = dharma.proposal(id);
        bytes memory sig = sign(pk, Dharma.Kind.Vote, p.op, p.data, id, support);
        dharma.vote(id, support, vm.addr(pk), nowTs() + 1 hours, sig);
    }

    function hostRemove(uint256 pk, address member) internal returns (uint256) {
        bytes memory sig = sign(pk, Dharma.Kind.Manage, Dharma.Op.RemoveMember, abi.encode(member), 0, false);
        return dharma.hostRemove(member, vm.addr(pk), nowTs() + 1 hours, sig);
    }

    function expectHostRemoveRevert(uint256 pk, address member, bytes4 err) internal {
        bytes memory sig = sign(pk, Dharma.Kind.Manage, Dharma.Op.RemoveMember, abi.encode(member), 0, false);
        vm.expectRevert(err);
        dharma.hostRemove(member, vm.addr(pk), nowTs() + 1 hours, sig);
    }

    function freeze(uint256 pk) internal {
        bytes memory sig = sign(pk, Dharma.Kind.Tighten, Dharma.Op.Freeze, "", 0, false);
        vm.prank(gk);
        dharma.tighten(Dharma.Op.Freeze, "", vm.addr(pk), nowTs() + 1 hours, sig);
    }

    /// bob joins (alice alone is a majority), then carol (alice + bob).
    function addBobAndCarol() internal {
        uint256 id = propose(aliceKey, Dharma.Op.AddMember, abi.encode(bob));
        vm.warp(nowTs() + TIMELOCK);
        dharma.execute(id);
        id = propose(aliceKey, Dharma.Op.AddMember, abi.encode(carol));
        vm.warp(nowTs() + 1);
        vote(bobKey, id, true);
        vm.warp(nowTs() + TIMELOCK);
        dharma.execute(id);
    }

    function isMember(address a) internal view returns (bool) {
        return dharma.isMember(a);
    }

    // ------------------------------------------------------------- tests

    function test_whoever_sets_the_org_up_is_its_host() public {
        assertEq(dharma.host(), alice);
        assertEq(dharma.version(), 7);
        addBobAndCarol();
        assertEq(dharma.host(), alice, "joining doesn't change the host");
    }

    function test_the_host_removes_a_teammate_without_a_vote_after_the_core_wait() public {
        addBobAndCarol();
        uint256 id = hostRemove(aliceKey, bob);
        Dharma.Proposal memory p = dharma.proposal(id);
        assertEq(uint8(p.status), uint8(Dharma.Status.Queued), "no vote needed");
        assertEq(p.eta, nowTs() + CORE, "but it waits the core wait");
        assertTrue(p.core, "and counts as a core change (a Freeze cancels it)");

        vm.expectRevert(Dharma.NotReady.selector);
        dharma.execute(id); // not before the wait
        assertTrue(isMember(bob));

        vm.warp(nowTs() + CORE);
        dharma.execute(id);
        assertFalse(isMember(bob), "removed");
        assertEq(dharma.members().length, 2);
    }

    function test_only_the_host_can_remove_without_a_vote() public {
        addBobAndCarol();
        expectHostRemoveRevert(bobKey, carol, Dharma.NoPermission.selector);
        expectHostRemoveRevert(carolKey, alice, Dharma.NoPermission.selector);
    }

    function test_the_host_cannot_remove_themselves_or_a_non_member_or_the_last_member() public {
        addBobAndCarol();
        expectHostRemoveRevert(aliceKey, alice, Dharma.CannotRemove.selector);
        expectHostRemoveRevert(aliceKey, makeAddr("stranger"), Dharma.CannotRemove.selector);
    }

    function test_any_member_can_stop_it_with_a_freeze_and_none_start_while_frozen() public {
        addBobAndCarol();
        uint256 id = hostRemove(aliceKey, bob);
        freeze(bobKey); // the member being removed (or anyone) sees it coming and freezes
        assertEq(uint8(dharma.proposal(id).status), uint8(Dharma.Status.Cancelled));
        vm.warp(nowTs() + CORE);
        vm.expectRevert(Dharma.NotReady.selector);
        dharma.execute(id);
        assertTrue(isMember(bob));
        // While frozen the host can't start another: unfreezing is the team's vote.
        expectHostRemoveRevert(aliceKey, bob, Dharma.AlreadyFrozen.selector);
    }

    function test_nobody_can_vote_on_a_host_removal() public {
        addBobAndCarol();
        uint256 id = hostRemove(aliceKey, bob);
        Dharma.Proposal memory p = dharma.proposal(id);
        bytes memory sig = sign(carolKey, Dharma.Kind.Vote, p.op, p.data, id, false);
        vm.expectRevert(Dharma.VotingClosed.selector);
        dharma.vote(id, false, carol, nowTs() + 1 hours, sig);
    }

    function test_a_signature_for_anything_else_cannot_be_turned_into_a_host_removal() public {
        addBobAndCarol();
        // A normal "propose removing bob" signature from the host doesn't work here.
        bytes memory sig = sign(aliceKey, Dharma.Kind.Propose, Dharma.Op.RemoveMember, abi.encode(bob), 0, false);
        vm.expectRevert(Dharma.BadSignature.selector);
        dharma.hostRemove(bob, alice, nowTs() + 1 hours, sig);
        // And a host-removal signature can't be sent to manage (role changes only).
        sig = sign(aliceKey, Dharma.Kind.Manage, Dharma.Op.RemoveMember, abi.encode(bob), 0, false);
        vm.expectRevert(Dharma.BadRole.selector);
        dharma.manage(Dharma.Op.RemoveMember, abi.encode(bob), alice, nowTs() + 1 hours, sig);
        // Nor reused for a different member.
        sig = sign(aliceKey, Dharma.Kind.Manage, Dharma.Op.RemoveMember, abi.encode(bob), 0, false);
        vm.expectRevert(Dharma.BadSignature.selector);
        dharma.hostRemove(carol, alice, nowTs() + 1 hours, sig);
    }

    function test_a_host_voted_out_leaves_no_host() public {
        addBobAndCarol();
        // Removing a member needs everyone else (bob + carol), then the core wait.
        uint256 id = propose(bobKey, Dharma.Op.RemoveMember, abi.encode(alice));
        vote(carolKey, id, true);
        vm.warp(nowTs() + CORE);
        dharma.execute(id);
        assertEq(dharma.host(), address(0), "nobody inherits the host role");
        expectHostRemoveRevert(bobKey, carol, Dharma.NoPermission.selector);
    }

    function test_an_org_upgraded_from_v5_makes_its_first_member_the_host_and_keeps_them() public {
        // A v5 org: alice set it up, then bob and carol joined.
        dharma = DharmaAbi(address(new DharmaProxy(address(new DharmaV5()), abi.encodeCall(DharmaV5.initialize, (gk, alice, TIMELOCK, CORE, 500e6, domains())))));
        addBobAndCarol();
        // Upgrade to v7 (a core change: every member, the core wait).
        DharmaCore next = v7();
        uint256 id = propose(aliceKey, Dharma.Op.Upgrade, abi.encode(address(next)));
        vote(bobKey, id, true);
        vote(carolKey, id, true);
        vm.warp(nowTs() + CORE);
        dharma.execute(id);
        assertEq(dharma.version(), 7);
        assertEq(dharma.host(), alice, "the first member is the host");

        // The team changes (carol leaves by vote, reordering the list): alice stays host.
        id = propose(aliceKey, Dharma.Op.RemoveMember, abi.encode(carol));
        vote(bobKey, id, true);
        vm.warp(nowTs() + CORE);
        dharma.execute(id);
        assertEq(dharma.host(), alice);

        // And the host's power works on the upgraded org.
        id = hostRemove(aliceKey, bob);
        vm.warp(nowTs() + CORE);
        dharma.execute(id);
        assertFalse(isMember(bob));
    }
}
