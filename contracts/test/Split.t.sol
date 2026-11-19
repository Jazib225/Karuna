// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Dharma as DharmaCore} from "../src/Dharma.sol";
import {DharmaBase as Dharma} from "../src/DharmaBase.sol";
import {DharmaExt} from "../src/DharmaExt.sol";
import {DharmaAbi} from "../src/DharmaAbi.sol";
import {DharmaProxy} from "../src/DharmaProxy.sol";
import {DharmaV5} from "./fixtures/DharmaV5.sol";

/// v6 splits Dharma's code in two (Dharma + DharmaExt). These tests check the split itself: calls
/// reach the right half on the org's storage, nothing leaks through the forwarding, and an org on
/// v5 upgrades to v6 without losing anything.
contract SplitTest is Test {
    DharmaAbi dharma;
    address gk = makeAddr("gatekeeper");
    uint256 aliceKey = 0xA11CE;
    uint256 bobKey = 0xB0B;
    address alice;
    address bob;

    uint64 constant TIMELOCK = 60;
    uint64 constant CORE = 1 days;
    bytes32 constant AGENT = bytes32("ops-agent");
    address constant PAYEE = address(0xBEEF);

    /// The time now. (`block.timestamp` can be cached across vm.warp under via_ir.)
    function nowTs() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function setUp() public {
        alice = vm.addr(aliceKey);
        bob = vm.addr(bobKey);
    }

    // ------------------------------------------------------------- helpers

    function v6() internal returns (DharmaCore) {
        return new DharmaCore(address(new DharmaExt()));
    }

    function deployV6() internal {
        string[] memory d = new string[](1);
        d[0] = "github.com";
        dharma = DharmaAbi(address(new DharmaProxy(address(v6()), abi.encodeCall(DharmaExt.initialize, (gk, alice, TIMELOCK, CORE, 500e6, d)))));
    }

    function deployV5() internal {
        string[] memory d = new string[](1);
        d[0] = "github.com";
        DharmaV5 impl = new DharmaV5();
        // v5 and v6 answer the same calls, so the org is driven through the v6 interface throughout.
        dharma = DharmaAbi(address(new DharmaProxy(address(impl), abi.encodeCall(DharmaV5.initialize, (gk, alice, TIMELOCK, CORE, 500e6, d)))));
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

    function manage(uint256 pk, Dharma.Op op, bytes memory data) internal {
        bytes memory sig = sign(pk, Dharma.Kind.Manage, op, data, 0, false);
        dharma.manage(op, data, vm.addr(pk), nowTs() + 1 hours, sig);
    }

    /// alice and bob both vote yes; waits whatever the proposal needs.
    function passBoth(Dharma.Op op, bytes memory data) internal returns (uint256 id) {
        id = propose(aliceKey, op, data);
        vote(bobKey, id, true);
        vm.warp(nowTs() + CORE);
        if (dharma.proposal(id).status == Dharma.Status.Queued) dharma.execute(id);
    }

    // ------------------------------------------------------------- the split

    function test_v6_sizes_leave_room_under_the_contract_limit() public {
        DharmaExt ext = new DharmaExt();
        DharmaCore core = new DharmaCore(address(ext));
        // EIP-170 is 24,576 bytes; keep at least 1 KB free in each half.
        assertLt(address(core).code.length, 24_576 - 1024);
        assertLt(address(ext).code.length, 24_576 - 1024);
    }

    function test_each_version_names_its_extension() public {
        deployV6();
        DharmaCore impl = DharmaCore(payable(dharma.implementation()));
        assertEq(dharma.ext(), impl.ext());
        assertGt(dharma.ext().code.length, 0);
        assertEq(dharma.version(), 6);
    }

    function test_the_core_refuses_an_extension_without_code() public {
        vm.expectRevert(Dharma.ZeroAddress.selector);
        new DharmaCore(makeAddr("no-code"));
    }

    function test_forwarded_calls_run_on_the_orgs_storage_and_emit_from_its_address() public {
        deployV6();
        // initialize ran through the forwarding, on the proxy's storage
        assertEq(dharma.gatekeeper(), gk);
        assertTrue(dharma.isMember(alice));
        assertEq(dharma.rules().length, 13);
        // a forwarded write emits from the org's address and changes the org's state
        vm.expectEmit(address(dharma));
        emit Dharma.LogAnchored(bytes32("h"), 3);
        vm.prank(gk);
        dharma.anchorLog(bytes32("h"), 3);
        assertEq(dharma.logLength(), 3);
        assertEq(dharma.logHead(), bytes32("h"));
    }

    function test_forwarded_errors_come_back_unchanged() public {
        deployV6();
        vm.expectRevert(Dharma.NotGatekeeper.selector);
        dharma.anchorLog(bytes32("h"), 1);
        vm.expectRevert(Dharma.BadLevel.selector);
        dharma.levelLimits(9);
        bytes memory data = abi.encode(uint8(3), uint16(1));
        bytes memory sig = sign(bobKey, Dharma.Kind.Manage, Dharma.Op.SetRolePerms, data, 0, false);
        vm.expectRevert(Dharma.NotMember.selector);
        dharma.manage(Dharma.Op.SetRolePerms, data, bob, nowTs() + 1 hours, sig);
    }

    function test_an_unknown_call_reverts() public {
        deployV6();
        (bool ok, bytes memory ret) = address(dharma).call(abi.encodeWithSignature("doesNotExist()"));
        assertFalse(ok);
        assertEq(ret.length, 0);
        (ok,) = address(dharma).call{value: 1}("");
        assertFalse(ok); // no plain transfers either
    }

    function test_setup_can_run_only_once_through_any_door() public {
        deployV6();
        string[] memory d = new string[](0);
        vm.expectRevert(Dharma.AlreadyInitialized.selector);
        dharma.initialize(makeAddr("evil"), makeAddr("evil"), 0, CORE, 0, d);
        // the implementation and the extension themselves can't be set up either
        DharmaAbi impl = DharmaAbi(dharma.implementation());
        DharmaExt ext = DharmaExt(dharma.ext());
        address evil = makeAddr("evil");
        vm.expectRevert(Dharma.AlreadyInitialized.selector);
        impl.initialize(evil, evil, 0, CORE, 0, d);
        vm.expectRevert(Dharma.AlreadyInitialized.selector);
        ext.initialize(evil, evil, 0, CORE, 0, d);
    }

    function test_the_extension_called_directly_holds_nothing_and_writes_nothing() public {
        deployV6();
        DharmaExt ext = DharmaExt(dharma.ext());
        assertEq(ext.gatekeeper(), address(0));
        assertEq(ext.members().length, 0);
        vm.prank(gk);
        vm.expectRevert(Dharma.NotGatekeeper.selector);
        ext.anchorLog(bytes32("h"), 1);
        vm.prank(gk);
        vm.expectRevert(Dharma.NotGatekeeper.selector);
        ext.reportTripwire(AGENT, "trap");
    }

    // ------------------------------------------------------------- v5 -> v6

    function test_a_v5_org_upgrades_to_v6_and_keeps_everything() public {
        deployV5();
        assertEq(dharma.version(), 5);

        // A lived-in v5 org: two members, a payee, an agent with a cap and a level, a block rule,
        // a custom role, a tree, the log anchored, and a proposal still waiting for a vote.
        uint256 id = propose(aliceKey, Dharma.Op.AddMember, abi.encode(bob));
        vm.warp(nowTs() + TIMELOCK);
        dharma.execute(id);
        passBoth(Dharma.Op.SetPayee, abi.encode(PAYEE, "supplies"));
        passBoth(Dharma.Op.SetAgent, abi.encode(AGENT, uint256(5e6)));
        passBoth(Dharma.Op.SetLevel, abi.encode(AGENT, uint8(2), "earned it"));
        passBoth(Dharma.Op.SetStructure, abi.encode(uint8(1)));
        manage(aliceKey, Dharma.Op.SetRolePerms, abi.encode(uint8(3), uint16(5)));
        manage(aliceKey, Dharma.Op.SetRole, abi.encode(bob, uint8(3)));
        vm.prank(gk);
        dharma.tighten(Dharma.Op.AddRule, abi.encode(bytes32("no-x"), uint8(Dharma.Outcome.Deny), AGENT, "http", "x.com", uint256(0)), address(0), 0, "");
        vm.prank(gk);
        dharma.anchorLog(bytes32("head"), 7);
        uint256 waiting = propose(aliceKey, Dharma.Op.AddDomain, abi.encode("stripe.com"));

        bytes32 domainBefore = dharma.DOMAIN_SEPARATOR();
        uint256 proposalsBefore = dharma.proposalCount();
        uint256 rulesBefore = dharma.rules().length;
        uint256 packedRoles = dharma.rolePerms();

        // The upgrade: a core change, so both members and the core wait.
        DharmaCore next = v6();
        passBoth(Dharma.Op.Upgrade, abi.encode(address(next)));

        assertEq(dharma.version(), 6);
        assertEq(dharma.implementation(), address(next));
        assertEq(dharma.ext(), next.ext());
        // Same address, same org.
        assertEq(dharma.DOMAIN_SEPARATOR(), domainBefore);
        assertEq(dharma.gatekeeper(), gk);
        assertEq(dharma.members().length, 2);
        assertEq(dharma.payees().length, 1);
        assertTrue(dharma.isPayee(PAYEE));
        (bytes32[] memory ids, uint256[] memory caps) = dharma.agents();
        assertEq(ids[0], AGENT);
        assertEq(caps[0], 5e6);
        (, uint8[] memory lvls) = dharma.levels();
        assertEq(lvls[0], 2);
        assertEq(dharma.rules().length, rulesBefore);
        assertEq(dharma.structure(), 1);
        assertEq(dharma.roleOf(alice), 1); // Admin: she set up the tree
        assertEq(dharma.roleOf(bob), 3);
        assertEq(dharma.rolePerms(), packedRoles);
        assertEq(dharma.permissionsOf(bob), 5);
        assertEq(dharma.logLength(), 7);
        assertEq(dharma.logHead(), bytes32("head"));
        assertEq(dharma.proposalCount(), proposalsBefore + 1); // + the upgrade itself

        // The proposal left waiting under v5 still counts its vote and runs under v6.
        assertTrue(dharma.hasVoted(waiting, alice));
        vote(bobKey, waiting, true);
        vm.warp(nowTs() + TIMELOCK);
        dharma.execute(waiting);
        assertEq(dharma.domains().length, 2);

        // Both halves keep working on the upgraded org.
        manage(aliceKey, Dharma.Op.SetRolePerms, abi.encode(uint8(4), uint16(1)));
        assertEq(dharma.rolePerms() >> 64 & 0xffff, 0x4001);
        vm.prank(gk);
        dharma.tighten(Dharma.Op.SetLevel, abi.encode(AGENT, uint8(0), "tripwire"), address(0), 0, "");
        (, lvls) = dharma.levels();
        assertEq(lvls[0], 0);
    }
}
