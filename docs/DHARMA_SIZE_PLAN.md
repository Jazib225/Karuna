# Dharma contract size: plan

> **Status (Nov 2026):** Option 2 is built as Dharma v6. Dharma is 16,218 bytes and DharmaExt is
> 16,120, each with about 8.4 KB free under the 24,576-byte limit (v5 was 24,537 bytes with 39 free).
> Storage layout matches v5 slot for slot. Tests: 93 contract tests (including a real upgrade from
> the exact v5 code, `test/fixtures/DharmaV5.sol`), plus the Gatekeeper's v2 → v6 upgrade on anvil.
> Option 1 is not built.
>
> Original problem: Dharma v5 sat 39 bytes under the limit (EIP-170, enforced on Arc), so almost
> any new feature would push it over. This plan frees room without changing any org's address,
> storage or the way members upgrade.

## Why

Dharma is already compiled for the smallest possible code (`via_ir`, `optimizer_runs = 1`), and v5
replaced every revert string with a custom error to fit. Those levers are spent. The remaining
fix is to move code out of the one contract.

Things that do **not** work:

| Idea | Why not |
|---|---|
| Tune the optimizer further | Already set for minimum size |
| Rely on a raised size limit | Arc testnet enforces the standard limit |
| Remove old features | Orgs on v4 and v5 depend on them |
| Split storage into a second contract | Breaks the append-only storage rule and every existing org |

Both options below keep storage where it is: in the org's DharmaProxy.

## Option 1: library for stateless logic

Move code that only reads its arguments (no storage) into an external library, `DharmaLib`,
deployed once per version. Dharma calls it with `DELEGATECALL`.

**Moves:** `isTightening` decoding, `_subject`, the `_validate` argument checks that need no
storage, the `requiredFor` arithmetic, `actionDigest` / `_recover`.

**Changes:**
- `contracts/src/DharmaLib.sol`: new library with `public` functions, so it deploys on its own.
- `Dharma.sol`: calls into the library. Public views (`isTightening`, `isCoreChange`) keep
  their selectors, so the ABI is unchanged.
- `contracts/js/build`: export `DHARMA_LIB_BYTECODE` and the link placeholder. Dharma's bytecode
  has to be linked with the library address before it is deployed.
- `gatekeeper/src/chain.ts`: `deploy()` and `deployCode()` deploy the library first (or reuse
  the one already deployed for this version), link it, then deploy Dharma. This applies to both
  the Circle CLI writer and the viem writer.

**Gain:** moderate (an estimated 2–4 KB). **Risk:** low. Behavior is identical and storage is
untouched. **Drawback:** linking adds a step to every deploy, and the headroom is limited, so the
problem comes back after a few more features.

## Option 2: two-part implementation (recommended)

Split the implementation into two contracts that share one storage layout:

- **Dharma:** the hot path. `propose`, `vote`, `execute`, `tighten`, `manage`, rule checks,
  signatures, `_apply`.
- **DharmaExt:** code that is rarely called or read-only. `initialize` and the built-in rules,
  every list view (`rules`, `payees`, `agents`, `levels`, `levelLimits`, `domains`, `members`,
  `proposal`, `rolePerms`), the Gatekeeper reports (`anchorWithRecord`, `reportTripwire`,
  `reportTestFailed`, `reportUnapprovedTransfer`), and role and structure helpers.

Dharma's `fallback` forwards any selector it doesn't recognize to DharmaExt with `DELEGATECALL`.
DharmaExt therefore runs on the proxy's storage, and its events come from the org's address.
Callers (console, Gatekeeper, Escrow, relay) keep using one address and one ABI.

```
 caller ──► DharmaProxy ──delegatecall──► Dharma (hot path)
             (storage)                      │ unknown selector
                                            └──delegatecall──► DharmaExt (views, setup, reports)
```

**Changes:**
- `contracts/src/DharmaStorage.sol`: every state variable and struct moves here, in the same
  order. Dharma and DharmaExt both inherit it, so the layout can't drift.
- `contracts/src/DharmaExt.sol`: the moved functions.
- `Dharma.sol`: the DharmaExt address becomes an `immutable` set in the constructor. Immutables
  live in code, not storage, so each Dharma version carries its own DharmaExt and an Upgrade
  vote moves both at once. Then add the forwarding `fallback`.
- `contracts/js/build`: export `DHARMA_EXT_BYTECODE`, and merge both ABIs into `DHARMA_ABI`.
  The build fails if the two contracts share a selector.
- `gatekeeper/src/chain.ts`: `deploy()` and `deployCode()` deploy DharmaExt, then Dharma with
  its address as the constructor argument. `prepareUpgrade` records both addresses.
- `version()` returns 6. The console's `DHARMA_LATEST` becomes 6, along with the upgrade card
  text.

**Gain:** large, an estimated third of the contract or more. That is room for several more
releases. **Risk:** moderate. Every moved function needs a test proving it behaves the same
through the proxy. **Drawback:** two deploys per version, and a forwarded call costs a few
hundred more gas.

## Tests

- Every existing Dharma test (61) and Escrow test (23) passes unchanged against v6.
- New tests:
  - each moved function returns the same result through the proxy as v5 did
  - an unknown selector that DharmaExt also lacks reverts
  - a v5 org upgraded to v6 keeps every rule, payee, agent, level, role and open proposal
  - selector clash check
- Gatekeeper: `upgrade.test.ts` and `levels.test.ts` expect v6. Deploy tests cover the two-step
  deploy for both writers.
- Size gate in CI: `forge build --sizes` fails if Dharma or DharmaExt is within 1 KB of the
  limit, so this never comes back as a surprise.

## Order

1. Add `DharmaStorage` and move the state into it, with no behavior change. Confirm the storage
   layout matches v5 using `forge inspect Dharma storageLayout`.
2. Option 2: add DharmaExt, move the functions, add the fallback and the immutable.
3. Merge the ABIs in the build and add the selector clash check.
4. Two-step deploy in the Gatekeeper, plus `prepareUpgrade`.
5. Console: version 6 and the upgrade card.
6. Add the CI size gate.

Option 1 can be added later on top of Option 2 if Dharma itself fills up again. The two don't
conflict.
