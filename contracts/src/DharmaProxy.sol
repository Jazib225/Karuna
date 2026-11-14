// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DharmaProxy — the org's permanent Dharma address
/// @notice A minimal ERC-1967 proxy. It holds the org's address and all of its state, and runs the
///         Dharma code it points at. Only Dharma itself can repoint it, through an executed `Upgrade`
///         proposal (every member + the core wait). This contract has no admin and no functions of
///         its own: everything goes to the current Dharma code.
contract DharmaProxy {
    /// ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    event Upgraded(address indexed implementation);

    /// @param implementation the Dharma code to run
    /// @param init the `initialize(...)` call, run in this proxy's storage in the same transaction,
    ///        so nobody can initialize the org before its creator does
    constructor(address implementation, bytes memory init) {
        require(implementation.code.length > 0, "no code");
        assembly {
            sstore(IMPLEMENTATION_SLOT, implementation)
        }
        emit Upgraded(implementation);
        (bool ok, bytes memory ret) = implementation.delegatecall(init);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    fallback() external payable {
        assembly {
            let impl := sload(IMPLEMENTATION_SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
