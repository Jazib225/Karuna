// Arc testnet config shared by the Gatekeeper, relay, and scripts.
import "dotenv/config";
import { createPublicClient, http, erc20Abi, type Address } from "viem";
import { arcTestnet } from "viem/chains";

export const ARC_CHAIN = arcTestnet;
export const ARC_RPC_URL = process.env.ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0];

// USDC ERC-20 interface on Arc (6 decimals). Native gas is also USDC (18 decimals internally).
export const USDC_ADDRESS: Address = "0x3600000000000000000000000000000000000000";
export const EXPLORER = "https://testnet.arcscan.app";

export const publicClient = createPublicClient({ chain: ARC_CHAIN, transport: http(ARC_RPC_URL) });

export async function usdcBalance(address: Address) {
  const [raw, decimals] = await Promise.all([
    publicClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    publicClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { raw, decimals };
}
