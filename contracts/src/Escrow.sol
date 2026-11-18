// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// What Escrow reads from the org's Dharma (the proxy address). Matches Dharma v3's views, plus v4's
/// `permissionsOf` (team roles), which Escrow uses when it's there.
interface IDharmaView {
    struct Payee {
        address account;
        string category;
    }

    function isMember(address a) external view returns (bool);
    function permissionsOf(address a) external view returns (uint16);
    function payees() external view returns (Payee[] memory);
    function frozen() external view returns (bool);
}

interface IERC20Min {
    function balanceOf(address a) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title Escrow — holds an org's large agent payments until a release time
/// @notice Large payments don't go straight to the payee. The org's Gatekeeper wallet sends a plain
///         USDC transfer here, then the Gatekeeper's opener account records a hold against that
///         balance with `open`. Until `releaseAt`, any one Dharma member can cancel it (directly, or
///         by signing `CancelEscrow` for a relayer); the USDC goes back to the org's wallet. From
///         `releaseAt`, anyone can release it, and it can only ever go to the payee recorded at open.
///         Each hold settles exactly once.
/// @dev    One Escrow per org. No owner and no upgrades: the only mutable setting is the opener,
///         which any one member may rotate by signature. One member is enough because the opener's
///         power is narrow: it can only earmark USDC already sent here, only for payees on Dharma's
///         list, and every hold it opens can still be cancelled by any member before release.
contract Escrow {
    // ------------------------------------------------------------------ types

    enum Status { None, Held, Released, Cancelled }

    struct Hold {
        address payee;
        uint256 amount; // USDC base units (6 decimals)
        uint64 releaseAt;
        Status status;
        bytes32 ref; // the Gatekeeper's id for this payment
    }

    // ------------------------------------------------------------------ events

    event Escrowed(uint256 indexed id, address indexed payee, uint256 amount, uint64 releaseAt, bytes32 indexed ref);
    event EscrowCancelled(uint256 indexed id, address indexed member);
    event EscrowReleased(uint256 indexed id);
    event OpenerSet(address indexed opener, address indexed by);
    event Swept(uint256 amount, address indexed by);

    // ------------------------------------------------------------------ errors

    error NotOpener();
    error NotMember();
    error NotPayee();
    error BadSignature();
    error Expired();
    error Frozen();
    error Invalid(string why);
    error Unfunded();
    error NotHeld();
    error TooEarly();
    error TransferFailed();

    // ------------------------------------------------------------------ constants & immutables

    bytes32 public constant CANCEL_TYPEHASH = keccak256("CancelEscrow(uint256 id)");
    bytes32 public constant SET_OPENER_TYPEHASH = keccak256("SetOpener(address opener,uint256 nonce,uint256 deadline)");

    IDharmaView public immutable dharma;
    IERC20Min public immutable usdc;
    /// The org's wallet: cancelled holds and swept balance go back here, and nowhere else.
    address public immutable refundTo;

    // ------------------------------------------------------------------ storage

    address public opener;
    uint256 public openerNonce; // bumps on each rotation, so a SetOpener signature works once
    uint256 public totalHeld;
    Hold[] internal _holds;
    mapping(bytes32 => uint256) internal _refId; // id + 1

    constructor(address dharma_, address usdc_, address refundTo_, address opener_) {
        if (dharma_ == address(0) || usdc_ == address(0) || refundTo_ == address(0) || opener_ == address(0)) {
            revert Invalid("zero address");
        }
        dharma = IDharmaView(dharma_);
        usdc = IERC20Min(usdc_);
        refundTo = refundTo_;
        opener = opener_;
        emit OpenerSet(opener_, address(0));
    }

    // ------------------------------------------------------------------ holds

    /// @notice Record a hold against USDC already sent here and not yet earmarked.
    function open(address payee, uint256 amount, uint64 releaseAt, bytes32 ref) external returns (uint256 id) {
        if (msg.sender != opener) revert NotOpener();
        if (amount == 0) revert Invalid("zero amount");
        if (releaseAt <= block.timestamp) revert Invalid("release time passed");
        if (ref == bytes32(0) || _refId[ref] != 0) revert Invalid("bad ref");
        if (!_isPayee(payee)) revert NotPayee();
        if (unaccounted() < amount) revert Unfunded();
        id = _holds.length;
        _holds.push(Hold(payee, amount, releaseAt, Status.Held, ref));
        _refId[ref] = id + 1;
        totalHeld += amount;
        emit Escrowed(id, payee, amount, releaseAt, ref);
    }

    /// @notice A member cancels a hold themselves. The USDC goes back to the org's wallet.
    function cancel(uint256 id) external {
        if (!_mayCancel(msg.sender)) revert NotMember();
        _cancel(id, msg.sender);
    }

    /// @dev On Dharma v4, only members whose role may cancel escrow; on older Dharma, any member.
    function _mayCancel(address a) private view returns (bool) {
        try dharma.permissionsOf(a) returns (uint16 p) {
            return p & 2 != 0;
        } catch {
            return dharma.isMember(a);
        }
    }

    /// @notice Anyone relays a member's signed `CancelEscrow(id)`. Replay is harmless: a hold settles
    ///         once, so a second submission reverts.
    function cancel(uint256 id, bytes calldata sig) external {
        address signer = _recover(cancelDigest(id), sig);
        if (signer == address(0)) revert BadSignature();
        if (!_mayCancel(signer)) revert NotMember();
        _cancel(id, signer);
    }

    /// @notice Anyone may release a hold at or after its release time. It pays the recorded payee
    ///         only, and only while that payee is still on Dharma's list and agents aren't frozen;
    ///         otherwise the hold waits for a member to cancel it (or for the freeze to lift).
    function release(uint256 id) external {
        Hold storage h = _held(id);
        if (block.timestamp < h.releaseAt) revert TooEarly();
        if (dharma.frozen()) revert Frozen();
        if (!_isPayee(h.payee)) revert NotPayee();
        h.status = Status.Released;
        totalHeld -= h.amount;
        emit EscrowReleased(id);
        _send(h.payee, h.amount);
    }

    /// @notice Return USDC sent here but never put on hold to the org's wallet. Holds are untouched.
    function sweep() external {
        if (msg.sender != opener && !dharma.isMember(msg.sender)) revert NotMember();
        uint256 amount = unaccounted();
        if (amount == 0) revert Invalid("nothing to sweep");
        emit Swept(amount, msg.sender);
        _send(refundTo, amount);
    }

    function _cancel(uint256 id, address member) private {
        Hold storage h = _held(id);
        h.status = Status.Cancelled;
        totalHeld -= h.amount;
        emit EscrowCancelled(id, member);
        _send(refundTo, h.amount);
    }

    function _held(uint256 id) private view returns (Hold storage h) {
        if (id >= _holds.length) revert Invalid("no such hold");
        h = _holds[id];
        if (h.status != Status.Held) revert NotHeld();
    }

    function _isPayee(address a) private view returns (bool) {
        if (a == address(0)) return false;
        IDharmaView.Payee[] memory ps = dharma.payees();
        for (uint256 i; i < ps.length; i++) if (ps[i].account == a) return true;
        return false;
    }

    function _send(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20Min.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    // ------------------------------------------------------------------ opener

    /// @notice Rotate the opener with one member's signed `SetOpener`. Anyone may relay it.
    function setOpener(address newOpener, uint256 deadline, bytes calldata sig) external {
        if (block.timestamp > deadline) revert Expired();
        if (newOpener == address(0)) revert Invalid("zero address");
        address signer = _recover(setOpenerDigest(newOpener, openerNonce, deadline), sig);
        if (signer == address(0)) revert BadSignature();
        if (!dharma.isMember(signer)) revert NotMember();
        openerNonce++;
        opener = newOpener;
        emit OpenerSet(newOpener, signer);
    }

    // ------------------------------------------------------------------ signatures

    /// @notice EIP-712 domain, the same shape as Dharma's, bound to this Escrow and chain.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Karuna Escrow"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function cancelDigest(uint256 id) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(CANCEL_TYPEHASH, id))));
    }

    function setOpenerDigest(address newOpener, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(SET_OPENER_TYPEHASH, newOpener, nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
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

    // ------------------------------------------------------------------ views

    /// @notice USDC here that no hold accounts for (what the next `open` can use).
    function unaccounted() public view returns (uint256) {
        return usdc.balanceOf(address(this)) - totalHeld;
    }

    function holds(uint256 id) external view returns (Hold memory) {
        if (id >= _holds.length) revert Invalid("no such hold");
        return _holds[id];
    }

    function holdCount() external view returns (uint256) {
        return _holds.length;
    }

    /// @notice The hold opened with this ref.
    function holdIdOf(bytes32 ref) external view returns (uint256) {
        uint256 i = _refId[ref];
        if (i == 0) revert Invalid("no such ref");
        return i - 1;
    }

    /// @notice Every hold still waiting (neither released nor cancelled).
    function openHolds() external view returns (uint256[] memory ids, Hold[] memory out) {
        uint256 n;
        for (uint256 i; i < _holds.length; i++) if (_holds[i].status == Status.Held) n++;
        ids = new uint256[](n);
        out = new Hold[](n);
        n = 0;
        for (uint256 i; i < _holds.length; i++) {
            if (_holds[i].status == Status.Held) {
                ids[n] = i;
                out[n++] = _holds[i];
            }
        }
    }
}
