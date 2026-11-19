// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Dharma} from "../src/Dharma.sol";
import {DharmaProxy} from "../src/DharmaProxy.sol";
import {Escrow} from "../src/Escrow.sol";

/// Minimal 6-decimal ERC-20 standing in for Arc's USDC.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract EscrowTest is Test {
    Dharma dharma;
    Escrow escrow;
    MockUSDC usdc;
    address gk = makeAddr("gatekeeper");
    address wallet = makeAddr("org-wallet"); // the Gatekeeper's USDC wallet
    address opener = makeAddr("opener");
    uint256 aliceKey = 0xA11CE;
    uint256 bobKey = 0xB0B;
    uint256 malloryKey = 0xBAD;
    address alice;
    address bob;

    uint64 constant TIMELOCK = 60;
    uint64 constant WINDOW = 1 hours;
    address constant PAYEE = address(0xBEEF);
    address constant STRANGER = address(0xF00D);
    bytes32 constant REF = keccak256("payment-1");

    function setUp() public {
        alice = vm.addr(aliceKey);
        bob = vm.addr(bobKey);
        Dharma impl = new Dharma();
        string[] memory d = new string[](0);
        dharma = Dharma(address(new DharmaProxy(address(impl), abi.encodeCall(Dharma.initialize, (gk, alice, TIMELOCK, 1 days, 500e6, d)))));
        pass(Dharma.Op.SetPayee, abi.encode(PAYEE, "supplies"));
        pass(Dharma.Op.AddMember, abi.encode(bob));
        usdc = new MockUSDC();
        usdc.mint(wallet, 10_000e6);
        escrow = new Escrow(address(dharma), address(usdc), wallet, opener);
    }

    // ------------------------------------------------------------- helpers

    function pass(Dharma.Op op, bytes memory data) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = dharma.actionDigest(Dharma.Kind.Propose, op, data, 0, false, dharma.nonces(alice), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
        uint256 id = dharma.propose(op, data, alice, deadline, abi.encodePacked(r, s, v));
        vm.warp(block.timestamp + TIMELOCK);
        dharma.execute(id);
    }

    /// Alice proposes, bob agrees (two members: both are needed).
    function passBoth(Dharma.Op op, bytes memory data) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = dharma.actionDigest(Dharma.Kind.Propose, op, data, 0, false, dharma.nonces(alice), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
        uint256 id = dharma.propose(op, data, alice, deadline, abi.encodePacked(r, s, v));
        Dharma.Proposal memory p = dharma.proposal(id);
        digest = dharma.actionDigest(Dharma.Kind.Vote, p.op, p.data, id, true, dharma.nonces(bob), deadline);
        (v, r, s) = vm.sign(bobKey, digest);
        dharma.vote(id, true, bob, deadline, abi.encodePacked(r, s, v));
        dharma.execute(id); // every member said yes: no wait
    }

    function manage(uint256 pk, Dharma.Op op, bytes memory data) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = dharma.actionDigest(Dharma.Kind.Manage, op, data, 0, false, dharma.nonces(vm.addr(pk)), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        dharma.manage(op, data, vm.addr(pk), deadline, abi.encodePacked(r, s, v));
    }

    function deposit(uint256 amount) internal {
        vm.prank(wallet); // the Gatekeeper's plain USDC transfer
        usdc.transfer(address(escrow), amount);
    }

    function openHold(uint256 amount, bytes32 ref) internal returns (uint256) {
        deposit(amount);
        vm.prank(opener);
        return escrow.open(PAYEE, amount, uint64(block.timestamp + WINDOW), ref);
    }

    function signDigest(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function status(uint256 id) internal view returns (Escrow.Status) {
        return escrow.holds(id).status;
    }

    // ------------------------------------------------------------- open

    function test_deposit_then_open_records_a_hold() public {
        deposit(800e6);
        uint64 at = uint64(block.timestamp + WINDOW);
        vm.expectEmit(true, true, true, true);
        emit Escrow.Escrowed(0, PAYEE, 800e6, at, REF);
        vm.prank(opener);
        uint256 id = escrow.open(PAYEE, 800e6, at, REF);

        assertEq(id, 0);
        Escrow.Hold memory h = escrow.holds(id);
        assertEq(h.payee, PAYEE);
        assertEq(h.amount, 800e6);
        assertEq(h.releaseAt, at);
        assertEq(h.ref, REF);
        assertEq(uint8(h.status), uint8(Escrow.Status.Held));
        assertEq(escrow.totalHeld(), 800e6);
        assertEq(escrow.unaccounted(), 0);
        assertEq(escrow.holdIdOf(REF), 0);
        (uint256[] memory ids,) = escrow.openHolds();
        assertEq(ids.length, 1);
    }

    function test_open_needs_unaccounted_balance() public {
        vm.prank(opener);
        vm.expectRevert(Escrow.Unfunded.selector);
        escrow.open(PAYEE, 1e6, uint64(block.timestamp + WINDOW), REF);

        // USDC already backing a hold can't back a second one.
        openHold(500e6, REF);
        vm.prank(opener);
        vm.expectRevert(Escrow.Unfunded.selector);
        escrow.open(PAYEE, 1, uint64(block.timestamp + WINDOW), keccak256("payment-2"));
    }

    function test_only_the_opener_can_open() public {
        deposit(500e6);
        vm.prank(gk);
        vm.expectRevert(Escrow.NotOpener.selector);
        escrow.open(PAYEE, 500e6, uint64(block.timestamp + WINDOW), REF);
        vm.prank(alice); // not even a member
        vm.expectRevert(Escrow.NotOpener.selector);
        escrow.open(PAYEE, 500e6, uint64(block.timestamp + WINDOW), REF);
    }

    function test_open_only_to_a_listed_payee() public {
        deposit(500e6);
        vm.prank(opener);
        vm.expectRevert(Escrow.NotPayee.selector);
        escrow.open(STRANGER, 500e6, uint64(block.timestamp + WINDOW), REF);
    }

    function test_open_rejects_zero_amount_and_past_release_time() public {
        deposit(500e6);
        vm.startPrank(opener);
        vm.expectRevert(abi.encodeWithSelector(Escrow.Invalid.selector, "zero amount"));
        escrow.open(PAYEE, 0, uint64(block.timestamp + WINDOW), REF);
        vm.expectRevert(abi.encodeWithSelector(Escrow.Invalid.selector, "release too soon"));
        escrow.open(PAYEE, 500e6, uint64(block.timestamp), REF);
        vm.stopPrank();
    }

    function test_duplicate_ref_reverts() public {
        openHold(500e6, REF);
        deposit(500e6);
        vm.prank(opener);
        vm.expectRevert(abi.encodeWithSelector(Escrow.Invalid.selector, "bad ref"));
        escrow.open(PAYEE, 500e6, uint64(block.timestamp + WINDOW), REF);
    }

    // ------------------------------------------------------------- cancel

    function test_member_signature_cancels_and_refunds_the_org_wallet() public {
        uint256 id = openHold(800e6, REF);
        uint256 before = usdc.balanceOf(wallet);
        bytes memory sig = signDigest(bobKey, escrow.cancelDigest(id));

        vm.expectEmit(true, true, false, false);
        emit Escrow.EscrowCancelled(id, bob);
        vm.prank(STRANGER); // anyone relays
        escrow.cancel(id, sig);

        assertEq(usdc.balanceOf(wallet), before + 800e6);
        assertEq(usdc.balanceOf(PAYEE), 0);
        assertEq(uint8(status(id)), uint8(Escrow.Status.Cancelled));
        assertEq(escrow.totalHeld(), 0);
        (uint256[] memory ids,) = escrow.openHolds();
        assertEq(ids.length, 0);

        // Replaying the signature does nothing: the hold already settled.
        vm.expectRevert(Escrow.NotHeld.selector);
        escrow.cancel(id, sig);
    }

    function test_non_member_signature_cannot_cancel() public {
        uint256 id = openHold(800e6, REF);
        bytes memory sig = signDigest(malloryKey, escrow.cancelDigest(id));
        vm.expectRevert(Escrow.NotMember.selector);
        escrow.cancel(id, sig);

        vm.expectRevert(Escrow.BadSignature.selector);
        escrow.cancel(id, hex"1234");

        // A member's signature for another hold doesn't cancel this one.
        bytes memory other = signDigest(aliceKey, escrow.cancelDigest(id + 1));
        vm.expectRevert(Escrow.NotMember.selector); // recovers to an unrelated address
        escrow.cancel(id, other);
        assertEq(uint8(status(id)), uint8(Escrow.Status.Held));
    }

    function test_member_can_cancel_directly() public {
        uint256 id = openHold(800e6, REF);
        vm.prank(STRANGER);
        vm.expectRevert(Escrow.NotMember.selector);
        escrow.cancel(id);

        vm.prank(alice);
        escrow.cancel(id);
        assertEq(uint8(status(id)), uint8(Escrow.Status.Cancelled));
        assertEq(usdc.balanceOf(wallet), 10_000e6);
    }

    function test_a_role_without_cancel_escrow_cannot_cancel() public {
        uint256 id = openHold(800e6, REF);
        passBoth(Dharma.Op.SetStructure, abi.encode(uint8(1))); // voted (two members): alice Admin, bob Member
        manage(aliceKey, Dharma.Op.SetRolePerms, abi.encode(uint8(2), uint16(15 & ~uint16(2))));
        vm.prank(bob);
        vm.expectRevert(Escrow.NotMember.selector);
        escrow.cancel(id);
        vm.prank(alice);
        escrow.cancel(id);
        assertEq(uint8(status(id)), uint8(Escrow.Status.Cancelled));
    }

    function test_cancel_works_until_release_even_after_the_window() public {
        uint256 id = openHold(800e6, REF);
        vm.warp(block.timestamp + WINDOW + 1 days); // nobody released it yet
        vm.prank(bob);
        escrow.cancel(id);
        assertEq(uint8(status(id)), uint8(Escrow.Status.Cancelled));
    }

    // ------------------------------------------------------------- release

    function test_release_after_window_pays_the_payee() public {
        uint256 id = openHold(800e6, REF);
        vm.warp(escrow.holds(id).releaseAt);
        vm.expectEmit(true, false, false, false);
        emit Escrow.EscrowReleased(id);
        vm.prank(STRANGER); // anyone may release
        escrow.release(id);
        assertEq(usdc.balanceOf(PAYEE), 800e6);
        assertEq(uint8(status(id)), uint8(Escrow.Status.Released));
        assertEq(escrow.totalHeld(), 0);
    }

    function test_no_early_release() public {
        uint256 id = openHold(800e6, REF);
        vm.warp(escrow.holds(id).releaseAt - 1);
        vm.expectRevert(Escrow.TooEarly.selector);
        escrow.release(id);
    }

    function test_each_hold_settles_once() public {
        uint256 id = openHold(800e6, REF);
        openHold(200e6, keccak256("payment-2")); // other funds here must stay put
        vm.warp(block.timestamp + WINDOW);
        escrow.release(id);
        vm.expectRevert(Escrow.NotHeld.selector);
        escrow.release(id);
        vm.prank(alice);
        vm.expectRevert(Escrow.NotHeld.selector);
        escrow.cancel(id);
        assertEq(usdc.balanceOf(PAYEE), 800e6);
        assertEq(usdc.balanceOf(address(escrow)), 200e6);

        uint256 c = escrow.holdIdOf(keccak256("payment-2"));
        vm.prank(alice);
        escrow.cancel(c);
        vm.expectRevert(Escrow.NotHeld.selector);
        escrow.release(c);
    }

    function test_release_waits_while_agents_are_frozen() public {
        uint256 id = openHold(800e6, REF);
        vm.warp(block.timestamp + WINDOW);

        // A member's Freeze holds every release; members can still cancel.
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = dharma.actionDigest(Dharma.Kind.Tighten, Dharma.Op.Freeze, "", 0, false, dharma.nonces(alice), deadline);
        dharma.tighten(Dharma.Op.Freeze, "", alice, deadline, signDigest(aliceKey, digest));
        vm.expectRevert(Escrow.Frozen.selector);
        escrow.release(id);
        vm.prank(bob);
        escrow.cancel(id);
        assertEq(usdc.balanceOf(wallet), 10_000e6);
    }

    function test_release_to_a_removed_payee_reverts() public {
        uint256 id = openHold(800e6, REF);
        vm.prank(gk);
        dharma.tighten(Dharma.Op.RemovePayee, abi.encode(PAYEE), address(0), 0, "");
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(Escrow.NotPayee.selector);
        escrow.release(id);
    }

    // ------------------------------------------------------------- opener rotation & sweep

    function test_member_signature_rotates_the_opener() public {
        address next = makeAddr("next-opener");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signDigest(aliceKey, escrow.setOpenerDigest(next, escrow.openerNonce(), deadline));
        vm.expectEmit(true, true, false, false);
        emit Escrow.OpenerSet(next, alice);
        vm.prank(STRANGER);
        escrow.setOpener(next, deadline, sig);
        assertEq(escrow.opener(), next);
        assertEq(escrow.openerNonce(), 1);

        // The old opener is out; the new one works.
        deposit(500e6);
        vm.prank(opener);
        vm.expectRevert(Escrow.NotOpener.selector);
        escrow.open(PAYEE, 500e6, uint64(block.timestamp + WINDOW), REF);
        vm.prank(next);
        escrow.open(PAYEE, 500e6, uint64(block.timestamp + WINDOW), REF);

        // The signature works once.
        vm.expectRevert(Escrow.NotMember.selector); // stale nonce: recovers to an unrelated address
        escrow.setOpener(next, deadline, sig);
    }

    function test_opener_rotation_needs_a_member_and_a_live_deadline() public {
        address next = makeAddr("next-opener");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory bad = signDigest(malloryKey, escrow.setOpenerDigest(next, 0, deadline));
        vm.expectRevert(Escrow.NotMember.selector);
        escrow.setOpener(next, deadline, bad);

        bytes memory sig = signDigest(aliceKey, escrow.setOpenerDigest(next, 0, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(Escrow.Expired.selector);
        escrow.setOpener(next, deadline, sig);
        assertEq(escrow.opener(), opener);
    }

    function test_sweep_returns_only_unaccounted_usdc() public {
        openHold(800e6, REF);
        deposit(50e6); // sent but never opened
        vm.prank(STRANGER);
        vm.expectRevert(Escrow.NotMember.selector);
        escrow.sweep();

        vm.prank(alice);
        escrow.sweep();
        assertEq(usdc.balanceOf(address(escrow)), 800e6);
        assertEq(usdc.balanceOf(wallet), 10_000e6 - 800e6);
        vm.prank(opener);
        vm.expectRevert(abi.encodeWithSelector(Escrow.Invalid.selector, "nothing to sweep"));
        escrow.sweep();
    }

    function test_constructor_rejects_zero_addresses() public {
        vm.expectRevert(abi.encodeWithSelector(Escrow.Invalid.selector, "zero address"));
        new Escrow(address(dharma), address(usdc), address(0), opener);
    }

    // ------------------------------------------------------------- v5 fixes

    /// Bob in a role with approve and propose only: no wallet, no cancelling.
    function bobWithoutWallet() internal {
        passBoth(Dharma.Op.SetStructure, abi.encode(uint8(1))); // alice Admin, bob Member
        manage(aliceKey, Dharma.Op.SetRolePerms, abi.encode(uint8(3), uint16(1 | 4)));
        manage(aliceKey, Dharma.Op.SetRole, abi.encode(bob, uint8(3)));
    }

    function test_only_a_member_who_may_manage_the_wallet_rotates_the_opener() public {
        bobWithoutWallet();
        address next = makeAddr("next-opener");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signDigest(bobKey, escrow.setOpenerDigest(next, 0, deadline));
        vm.expectRevert(Escrow.NotMember.selector);
        escrow.setOpener(next, deadline, sig);
        sig = signDigest(aliceKey, escrow.setOpenerDigest(next, 0, deadline));
        escrow.setOpener(next, deadline, sig);
        assertEq(escrow.opener(), next);
    }

    function test_only_the_opener_or_a_wallet_member_sweeps() public {
        bobWithoutWallet();
        deposit(50e6);
        vm.prank(bob);
        vm.expectRevert(Escrow.NotMember.selector);
        escrow.sweep();
        vm.prank(alice);
        escrow.sweep();
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_a_hold_always_leaves_time_to_cancel() public {
        deposit(500e6);
        vm.startPrank(opener);
        vm.expectRevert(abi.encodeWithSelector(Escrow.Invalid.selector, "release too soon"));
        escrow.open(PAYEE, 500e6, uint64(block.timestamp + 59), REF);
        escrow.open(PAYEE, 500e6, uint64(block.timestamp + 60), REF);
        vm.stopPrank();
    }
}
