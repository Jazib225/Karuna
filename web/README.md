# @prekaruna/web — the Karuna Console

The **product frontend**: the app Maya's Bakery logs into to supervise its agents. This is
**not** the marketing site (karunaprotocol.dev) — that site links *into* this console. It wears
the same brand (Inter / Geist Mono, monochrome palette) but it's an application.

```bash
pnpm --dir web dev      # http://localhost:5173
```

## Design
Same visual language as karunaprotocol.dev: Inter + Geist Mono, monochrome palette, a
centered container with rails and `+` crosshairs, a topographic contour texture behind page
headers, grey "frames" holding glass panels, `—— EYEBROW` labels, and two-tone headlines.
The live gatekeeper window types new decisions in, with a floating signed decision-log card.

## Views
| View | What |
|---|---|
| **Overview** | Stat tiles (pending, decisions, blocked, spent), approvals waiting, agent meters, recent activity |
| **Approvals** | **Facts First** cards — Karuna's verified facts on top, the agent's reason boxed & labeled untrusted; **Exact Match** on the payload hash; **Two-Person Approval** over $500 |
| **Agents** | Bills / Supplies / Research with live allowance meters, status, action counts |
| **Policy** | The active ruleset (from the real engine), first-match order, core-boundary note |
| **Activity log** | The signed, hash-chained decision feed, filterable by outcome |

## Powered by the real engine
The approval queue and activity feed are produced by **`@prekaruna/engine`** running in the
browser (`src/engine/` is a copy of the pure, node-free engine) — not hardcoded verdicts. The
**Panic button** freezes every agent (unfreeze needs a vote). Member switcher toggles Maya/Sam.

## Wiring in later phases
Today the data is a seeded local simulation. Phase 2 swaps the queue for the Gatekeeper's real
proposals; Phase 4 replaces the local ticker with the QuickNode → relay → WebSocket stream, so
approval cards pop up live on every member's screen.
