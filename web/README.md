# @prekaruna/web — the Karuna Console

The product frontend: where an organization's people supervise their agents. It shows only what
the Gatekeeper reports — nothing is simulated or built in. A new install opens on a setup screen.

```bash
pnpm --dir web dev      # http://127.0.0.1:5173 (needs the Gatekeeper running)
```

## Screens
| Screen | What |
|---|---|
| **Setup** | First run: organization name, your name, the wallet (detected) — deploys the org's Dharma with this browser's key as first member |
| **Join** | A browser that isn't a member asks to join; a member proposes adding it |
| **Overview** | Waiting approvals, wallet + Gateway balance, spend, getting-started checklist, recent decisions |
| **Approvals** | Facts First cards; approve/deny is **signed by your browser key** over the payload hash (Exact Match); two-person approval needs two members' keys |
| **Dharma** | The org's contract, policy version, votes in progress with live timelock countdowns, sign yes/no, history |
| **Agents** | Propose an agent (token shown once; works after the vote), allowance meters, lower now / raise by vote, rotate token, remove |
| **Payees & services** | Dharma's payee list; add by vote, remove at once |
| **Policy** | Dharma's rules (core boundaries locked), add block / approval rules instantly, domains, two-person threshold |
| **Signed log** | Every decision and event, hash-chained and signed, with the chain-verification status |
| **Team** | Members who approve, deny, panic, and vote to unfreeze |

Live updates come from the Gatekeeper over server-sent events. The dev server proxies `/api` to
the console API and adds the console secret server-side; it binds to 127.0.0.1 only.

Each browser keeps one signing key (local storage). That browser *is* that member: votes and
approvals are signed there, and the Gatekeeper only relays them. Clearing site data loses the
key — another member then proposes adding the new one. Names stay off-chain.
