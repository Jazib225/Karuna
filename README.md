# PreKaruna

Hackathon build of the Karuna **Organizations layer** (Dharma on Arc, Auto-Shield, Swarm Stopper, live approvals) for UBC 2026.
Read [`CLAUDE.md`](CLAUDE.md) for the product and [`ROADMAP.md`](ROADMAP.md) for the plan.

## Layout
| Folder | What |
|---|---|
| `engine/` | Deterministic first-match policy engine (Phase 1) |
| `gatekeeper/` | Holds the Circle wallet; the only process with keys (Phase 2) |
| `contracts/` | Dharma Solidity contract on Arc (Phase 3) |
| `relay/` | QuickNode Streams webhook → WebSocket (Phase 4) |
| `web/` | React approval UI (Phase 4) |
| `agents/` | Bills / Supplies / Research agents, sandboxed (Phase 6) |

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

## Phase 0 setup
```bash
pnpm install
cp .env.example .env          # fill in ARC_RPC_URL (QuickNode) and BAKERY_WALLET_ADDRESS
pnpm check:arc                # chain id, block, USDC token
pnpm balance                  # ✅ Phase 0 passes when this prints the bakery wallet's USDC
```

Tools: Node ≥ 20.18, pnpm, [Circle CLI](https://developers.circle.com/agent-stack/circle-cli/command-reference) (`npm i -g @circle-fin/cli`), [Foundry](https://getfoundry.sh).
