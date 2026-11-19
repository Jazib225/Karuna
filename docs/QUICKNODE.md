# QuickNode setup (Arc testnet)

We use QuickNode twice:
1. **An RPC endpoint** on Arc testnet — a faster, private node for the Gatekeeper and scripts (Phase 0).
2. **One Stream** on Arc testnet, `karuna-events` (the free plan allows one), delivering to our relay's
   signed webhook. It is **backfilled from Dharma's deploy block**, then live, and its
   filter keeps Dharma's events (approval pop-ups, and every agent's record for trust levels) and USDC
   `Transfer` logs out of the org's wallet (the watchdog: each must match a payment Karuna made, or
   every agent freezes).

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

## Part B — Stream (Phase 4): live alerts on every member's screen

The relay is built and tested; it runs on the direct-RPC fallback until this is connected. Three
things only you can do, then one command:

1. **Install `cloudflared`** (free quick tunnel, no account) so QuickNode can reach your relay:
   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. **Start a tunnel to the relay's webhook port** (leave it running):
   ```bash
   cloudflared tunnel --url http://127.0.0.1:8791
   ```
   It prints a `https://…trycloudflare.com` URL. Put it in `.env`:
   `RELAY_PUBLIC_URL=https://….trycloudflare.com`
3. **QuickNode API key** — dashboard → API Keys → create one with Streams access. It's a secret:
   add it to `.env` yourself as `QUICKNODE_API_KEY=…` (don't paste it in chat).
4. Then:
   ```bash
   pnpm --dir relay stream:create
   ```
   It first test-runs the filter on QuickNode against real blocks, then
   creates the Stream, generates the security token into `.env` (`QUICKNODE_SECURITY_TOKEN`), and
   saves the Stream id. Restart the relay; the console badge switches to **QuickNode live**.

**If you restart `cloudflared`, it gets a new URL.** Put the new one in `.env` as
`RELAY_PUBLIC_URL` and run `pnpm --dir relay stream:create` again — it updates the existing Stream
(id in `relay/.stream.json`) instead of making a new one. A named Cloudflare tunnel keeps a fixed URL.

**Free-plan note:** QuickNode's Discover plan caps `eth_getLogs` at a 5-block range, so log queries
(the relay's safety net, the setup script) use Arc's public RPC; set `ARC_LOGS_RPC_URL` to override.
Everything else uses your QuickNode endpoint (`ARC_RPC_URL`).

### The Stream's config
| Setting | Value | Why |
|---|---|---|
| Network | `arc-testnet` | Dharma lives on Arc |
| Dataset | `logs` | Dharma's state changes are all events |
| Filter | JavaScript `main()` keeping only logs whose topic0 is a Dharma event (generated from the ABI in `relay/src/events.ts`) | Sends only governance + alert events; one Stream serves any org — the relay keeps just its own Dharma |
| Destination | Webhook → `https://<tunnel>/quicknode/webhook`, HMAC security token, no compression, 3 retries | Signed so nobody can inject fake alerts; the relay refuses unsigned or replayed deliveries |
| Batch | 1 block, elastic batching on | Lowest latency for approval pop-ups |

---

### Backup (if Streams is slow or down during the demo)
The relay automatically reads Dharma's events straight from Arc (`eth_getLogs` every 3s) whenever
QuickNode hasn't delivered for 45s, and de-duplicates if both arrive. The console badge shows
which path is live ("QuickNode live" / "Arc RPC (fallback)").
