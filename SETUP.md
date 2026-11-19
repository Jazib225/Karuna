# Phase 0 setup — done Nov 9, 2026

Status: **complete.** Phase 0 "It works if" passes — `pnpm balance <address>` reads a wallet's USDC from Arc testnet.

## Accounts & tools
- **GitHub repo:** https://github.com/Jazib225/PreKaruna (private)
- **Circle CLI:** logged in as jazibrq0@gmail.com (testnet session, expires in 28 days)
- **Foundry:** forge 1.9.0 at `~/.foundry/bin` (add to PATH: `export PATH="$HOME/.foundry/bin:$PATH"`)
- **GitHub CLI:** `~/.local/bin/gh`

## Arc testnet
- Chain ID `5042002`, USDC (6 decimals) at `0x3600000000000000000000000000000000000000`
- Public RPC `https://rpc.testnet.arc.network` (viem resolves `rpc.testnet.arc.io`)
- Explorer https://testnet.arcscan.app

## Wallets (Circle agent wallets on ARC-TESTNET)
- `0x185ea7a520be17f4e5c4504b3581bf6af5018328` — funded from the faucet, 1 USDC deposited to Gateway for nanopayments. Pick it in the console's setup screen.
- `0xc55a1499aab6747e1edf23e930b6e92c60a18fdb` — used as the test seller's payout address during Phase 2 verification.

The wallet an organization uses is chosen in the console at setup; it is not configured in `.env`.

## Still to do
- QuickNode Arc testnet endpoint → put in `.env` as `ARC_RPC_URL` (secret token; don't paste in chat). Public RPC works until then.

## Commands
```bash
pnpm check:arc    # chain id, block, USDC token
pnpm balance      # the org's Gatekeeper wallet balance (after setup), or pass an address
```
