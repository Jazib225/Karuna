// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Dharma} from "./Dharma.sol";
import {DharmaExt} from "./DharmaExt.sol";

/// @title DharmaAbi: an org's Dharma as callers see it
/// @notice Both halves as one interface: what the org's address answers. Never deployed. The
///         TypeScript ABI is exported from this, and the compiler rejects it if the two halves ever
///         share a function selector (a call would silently reach the wrong half).
abstract contract DharmaAbi is Dharma, DharmaExt {}
