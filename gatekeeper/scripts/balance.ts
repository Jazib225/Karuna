// Phase 0 "It works if": print the bakery wallet's USDC balance on Arc testnet.
import { formatUnits, isAddress, type Address } from "viem";
import { publicClient, usdcBalance, EXPLORER } from "../src/arc.ts";

const addr = process.argv[2] || process.env.BAKERY_WALLET_ADDRESS;
if (!addr || !isAddress(addr)) {
  console.error("Usage: pnpm balance <0xAddress>  (or set BAKERY_WALLET_ADDRESS in .env)");
  process.exit(1);
}
const { raw, decimals } = await usdcBalance(addr as Address);
const native = await publicClient.getBalance({ address: addr as Address });
console.log(`Wallet:        ${addr}`);
console.log(`USDC (ERC-20): ${formatUnits(raw, decimals)}`);
console.log(`Native (gas):  ${formatUnits(native, 18)} USDC`);
console.log(`Explorer:      ${EXPLORER}/address/${addr}`);
