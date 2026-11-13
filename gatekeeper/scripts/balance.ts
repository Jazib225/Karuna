// Print a wallet's USDC balance on Arc testnet.
//   pnpm balance <0xAddress>     any address
//   pnpm balance                 the org's Gatekeeper wallet (from gatekeeper/data/org.json)
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits, isAddress, type Address } from "viem";
import { publicClient, usdcBalance, EXPLORER } from "../src/arc.ts";

const here = dirname(fileURLToPath(import.meta.url));
const orgFile = resolve(process.env.KARUNA_DATA_DIR ?? resolve(here, "../data"), "org.json");
const fromOrg = existsSync(orgFile) ? (JSON.parse(readFileSync(orgFile, "utf8")).wallet?.address as string | undefined) : undefined;

const addr = process.argv[2] || fromOrg;
if (!addr || !isAddress(addr)) {
  console.error("Usage: pnpm balance <0xAddress>   (or finish setup in the console so the org has a wallet)");
  process.exit(1);
}
const { raw, decimals } = await usdcBalance(addr as Address);
const native = await publicClient.getBalance({ address: addr as Address });
console.log(`Wallet:        ${addr}`);
console.log(`USDC (ERC-20): ${formatUnits(raw, decimals)}`);
console.log(`Native (gas):  ${formatUnits(native, 18)} USDC`);
console.log(`Explorer:      ${EXPLORER}/address/${addr}`);
