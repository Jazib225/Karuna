# QuickNode setup (Arc testnet)

We use QuickNode twice:
1. **An RPC endpoint** on Arc testnet — a faster, private node for the Gatekeeper and scripts (Phase 0).
2. **A Stream** on Arc testnet — watches the Dharma contract's events and pushes them to our relay, which drives the live approval pop-ups (Phase 4, and the $500 bounty).

Do **part A now**. Part B waits until the Dharma contract is deployed (Phase 3), because a Stream needs the contract address.

---

## Part A — RPC endpoint (do now, ~3 min)

1. Sign up / log in at **https://dashboard.quicknode.com**.
2. Click **Create Endpoint** (or **Endpoints → Create**).
3. Chain: **Arc**. Network: **Arc Testnet**. (If Arc isn't listed yet, skip this — the public RPC `https://rpc.testnet.arc.network` works fine, and you can add QuickNode later.)
4. Create it. You'll get an **HTTP Provider URL** and a **WSS URL** that look like:
   `https://<name>.arc-testnet.quiknode.pro/<TOKEN>/`
5. **The URL contains a secret token — treat it like a password. Don't paste it in chat.** Put it in `.env` yourself:
   ```
   ARC_RPC_URL=https://<name>.arc-testnet.quiknode.pro/<TOKEN>/
   ARC_WS_URL=wss://<name>.arc-testnet.quiknode.pro/<TOKEN>/
   ```
6. Verify it (prints only the host, never the token):
   ```bash
   pnpm check:arc
   ```
   It should print your QuickNode host and `Chain ID: 5042002 OK`.

Just tell me "QuickNode is in .env" — I don't need to see the URL.

---

## Part B — Stream (Phase 4, after the Dharma contract is deployed)

For the submission (QuickNode bounty requires "Streams as a core data source"):

1. Dashboard → **Streams → Create Stream**.
2. Network: **Arc Testnet**.
3. Dataset: **Logs / Receipts** (contract events).
4. **Filter** to our Dharma contract only — by address, and by the event topics we emit
   (`ApprovalRequested`, `AgentFrozen`, `TestFailed`, `RuleAdded`, `VoteCast`). We'll paste the
   filter function once the contract address exists.
5. Destination: **Webhook** → our relay's public URL (e.g. an ngrok/Cloudflare tunnel in dev,
   `POST /quicknode/webhook`). Enable the **signing/security token** so the relay can verify it.
6. Start the Stream. The relay verifies the signature → pushes to browsers over WebSocket →
   Maya's and Sam's screens light up.

We'll record the exact config (network, dataset, filter logic, destination, and *why*) in the
main README for the submission checklist.

---

### Backup (if QuickNode Streams is slow during the demo)
The relay can subscribe directly to Arc over `ARC_WS_URL` (QuickNode or public) and get the same
events. Streams stays the headline path; the direct WS is the fallback (ROADMAP backup plan).
