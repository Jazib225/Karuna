# @prekaruna/web — the Karuna Console

The product frontend: where an organization's people supervise their agents. It shows only what
the Gatekeeper reports — nothing is simulated or built in. A new install opens on a setup screen.

```bash
pnpm --dir web dev      # http://127.0.0.1:5173 (needs the Gatekeeper running)
```

## Screens
| Screen | What |
|---|---|
| **Setup** | First run: organization name, your name, and the wallet the Gatekeeper pays from (Circle agent wallets on this machine are detected) |
| **Overview** | Waiting approvals, wallet + Gateway balance, spend, getting-started checklist, recent decisions |
| **Approvals** | Facts First cards (Karuna-verified facts; the agent's reason boxed as untrusted), Exact Match approval by payload hash, two-person approval, recently resolved with refusal reasons |
| **Agents** | Add an agent (token shown once), daily allowance meters, edit allowance, rotate token, remove |
| **Payees & services** | The addresses agents may pay; everything else is denied |
| **Policy** | The active rules, allowlisted domains, two-person threshold |
| **Signed log** | Every decision and event, hash-chained and signed, with the chain-verification status |
| **Team** | Members who approve, deny, panic, and vote to unfreeze |

Live updates come from the Gatekeeper over server-sent events. The dev server proxies `/api` to
the console API and adds the console secret server-side; it binds to 127.0.0.1 only.

Note: members are chosen with "acting as" — there is no login yet, so anyone who can open the
console can act as any member. Don't expose it beyond this machine.
