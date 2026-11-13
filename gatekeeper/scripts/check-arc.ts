// Phase 0: confirm we can talk to Arc testnet.
import { publicClient, ARC_RPC_URL, ARC_CHAIN, USDC_ADDRESS } from "../src/arc.ts";
import { erc20Abi } from "viem";

const host = new URL(ARC_RPC_URL).host; // never print full URL (QuickNode URLs embed a token)
const [chainId, block, symbol, decimals] = await Promise.all([
  publicClient.getChainId(),
  publicClient.getBlockNumber(),
  publicClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "symbol" }),
  publicClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "decimals" }),
]);
console.log(`RPC host:   ${host}`);
console.log(`Chain ID:   ${chainId} (expected ${ARC_CHAIN.id}) ${chainId === ARC_CHAIN.id ? "OK" : "MISMATCH"}`);
console.log(`Block:      ${block}`);
console.log(`USDC token: ${symbol}, ${decimals} decimals at ${USDC_ADDRESS}`);
