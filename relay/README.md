# @prekaruna/relay — live chain events (Phase 4)

Gets every Dharma event from Arc onto every member's screen within seconds, and tells the
Gatekeeper to re-read policy the moment it changes.

```
QuickNode Stream (arc-testnet, logs, Dharma-only filter)
   │  signed webhook → public port 8791 (via a tunnel)
   ▼
relay ── verifies HMAC, drops replays, keeps only this org's Dharma ──▶ consoles (WebSocket, 127.0.0.1:8790)
   ▲                                                                 └▶ Gatekeeper: POST /api/chain-event → re-sync
   │  fallback when QuickNode is quiet (or not set up)
Arc RPC (eth_getLogs every 3s)
```

```bash
pnpm --dir relay start           # 8790 consoles (localhost) · 8791 QuickNode webhook
pnpm --dir relay test            # signature, replay, gzip, decoding, filter, de-duplication
pnpm --dir relay stream:create   # create/update the QuickNode Stream (see docs/QUICKNODE.md)
```

## Why it's built this way
- **Two ports.** Only the webhook port is ever exposed publicly, and it does one thing: accept
  deliveries whose `X-QN-Signature` is `HMAC-SHA256(token, nonce + timestamp + body)`. Everything
  else (the WebSocket consoles use) listens on 127.0.0.1.
- **Replays refused** (each `X-QN-Nonce` once); gzip bodies are verified on the decoded payload.
- **Only your org.** The Stream forwards events from *any* Dharma on Arc; the relay keeps only the
  address your Gatekeeper reports (`KARUNA_DHARMA_ADDRESS` to pin it). Unknown org → nothing.
- **Never silent.** If QuickNode hasn't delivered for 45s (or isn't configured), the relay reads
  Arc directly; events seen by both paths are de-duplicated. The console shows which path is live.
- **Public data only.** Everything relayed is already onchain; names are added by the console.

## Events that pop up in the console
`ApprovalRequested` (Review) · `AgentFrozen` (red) · `ProposalCreated` (Vote) · `VoteCast` ·
`ProposalQueued` · `ProposalExecuted` · `ProposalDefeated` · `AgentsUnfrozen` · `RuleAdded` ·
`TestFailed`. Other events (payees, domains, anchors) refresh the screen without a pop-up.
