# PreKaruna

Hackathon build of the Karuna **Organizations layer** (Dharma on Arc, Auto-Shield, Swarm Stopper, live approvals) for UBC 2026.
Read [`CLAUDE.md`](CLAUDE.md) for the product and [`ROADMAP.md`](ROADMAP.md) for the plan.

## Layout
| Folder | What |
|---|---|
| `engine/` | Deterministic first-match policy engine + signed log (Phase 1) ✅ |
| `gatekeeper/` | The only process that holds the wallet: proposals, approvals, payments, Exact Match (Phase 2) ✅ |
| Auto-Shield (in `gatekeeper/`) | Fake-scam tests → per-agent, per-category block rules on Dharma; changed-bank-account alerts (Phase 5) ✅ |
| `contracts/` | **Dharma** — the org's onchain rulebook on Arc + shared TS vocabulary (Phase 3) ✅ |
| `relay/` | QuickNode Stream → verified Dharma events → every member's console + Gatekeeper refresh; direct-RPC fallback (Phase 4) ✅ |
| `web/` | Karuna Console — the product frontend (setup, approvals, agents, payees, policy, signed log) |
| `agents/` | Agent-side client: propose, read inbox, flag scams; no keys. `examples/payables-agent.ts` (gullible / `--careful`) |
| `services/test-seller/` | **Test fixture only** — a local x402 seller used to verify payments |

## Arc testnet facts (verified Nov 9, 2026)
| | |
|---|---|
| Chain ID | `5042002` |
| Public RPC | `https://rpc.testnet.arc.network` (viem default: `rpc.testnet.arc.io`) |
| USDC (ERC-20, 6 decimals) | `0x3600000000000000000000000000000000000000` |
| Gas token | USDC (native, 18 decimals) |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com (20 USDC / 2h) or `circle wallet fund` |
| Circle CLI chain id | `ARC-TESTNET` |

**Circle wallet spending limits are mainnet only**, so on testnet Dharma and the Gatekeeper enforce limits.

## Run it locally
```bash
git submodule update --init           # Foundry's forge-std, for the contract tests
pnpm install
cp .env.example .env                  # optional: put your QuickNode Arc URL in ARC_RPC_URL
circle wallet login <email> --testnet # the Gatekeeper pays with this Circle session
pnpm --dir gatekeeper start           # agent API :8787 · console API :8788
pnpm --dir relay start                # live chain events (QuickNode or direct RPC) :8790 / :8791
pnpm --dir web dev                    # console at http://127.0.0.1:5173
```
A new install opens on **setup**: name your organization, pick the wallet, and Karuna deploys your
organization's own **Dharma** contract on Arc with this browser's signing key as its first member.
Then propose agents, payees, and teammates — loosenings pass by vote after a timelock; tightenings
(blocks, lower limits, removals, panic) apply at once. Nothing about any organization is built in.

Each member uses their own browser: it holds the key that signs their votes and approvals.

For x402 services the wallet also needs a Gateway balance:
`circle gateway deposit --amount 1 --address 0x… --chain ARC-TESTNET --method direct`.

## Tests
```bash
pnpm --dir engine test       # policy engine + signed log + Dharma rule ordering
pnpm --dir contracts test    # Dharma (forge)
pnpm --dir gatekeeper test   # gatekeeper against the real Dharma on a local chain (anvil)
pnpm --dir relay test        # QuickNode signature, replay, decoding, filter
pnpm --dir agents check:no-keys
# live, on Arc testnet (needs the test seller running):
TEST_SELLER_ADDRESS=0x… pnpm --dir services/test-seller start
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase2   # payments (needs the test seller)
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase3   # Dharma: tighten / loosen / core / explorer
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase5   # Auto-Shield: fake invoice → block onchain → vote restores
```

Tools: Node ≥ 22, pnpm, [Circle CLI](https://developers.circle.com/agent-stack/circle-cli/command-reference) (`npm i -g @circle-fin/cli`), [Foundry](https://getfoundry.sh).
