import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, type Hex } from "viem";
import { DHARMA_ABI, toBytes32 } from "@prekaruna/dharma";
import { decodeDharmaLogs, extractLogs, quickNodeFilterSource, verifyQuickNodeSignature, type RawLog } from "../src/events.ts";
import { Relay, webhookServer } from "../src/relay.ts";

const ORG = "0x00000000000000000000000000000000000000d1";
const OTHER_ORG = "0x00000000000000000000000000000000000000d2";
const TOKEN = "qn-test-security-token";

function approvalLog(address = ORG, logIndex = 0): RawLog {
  const topics = encodeEventTopics({
    abi: DHARMA_ABI, eventName: "ApprovalRequested",
    args: { requestId: keccak256(stringToHex("proposal-1")), agent: toBytes32("ops-agent") },
  }) as string[];
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [900_000_000n, `0x${"ab".repeat(32)}` as Hex]);
  return { address, topics, data, blockNumber: "0x10", transactionHash: `0x${"01".repeat(32)}`, logIndex: `0x${logIndex.toString(16)}` };
}
function frozenLog(by: string): RawLog {
  const topics = encodeEventTopics({ abi: DHARMA_ABI, eventName: "AgentFrozen", args: { by: by as Hex } }) as string[];
  return { address: ORG, topics, data: "0x", blockNumber: 17, transactionHash: `0x${"02".repeat(32)}`, logIndex: 0 };
}
const sign = (nonce: string, ts: string, body: string, key = TOKEN) => createHmac("sha256", Buffer.from(key)).update(nonce + ts + body).digest("hex");

describe("QuickNode signature (HMAC-SHA256 over nonce + timestamp + payload, hex)", () => {
  it("accepts a correct signature and rejects tampering", () => {
    const body = JSON.stringify({ data: [approvalLog()] });
    const sig = sign("n1", "1731200000", body);
    expect(verifyQuickNodeSignature(TOKEN, "n1", "1731200000", body, sig)).toBe(true);
    expect(verifyQuickNodeSignature(TOKEN, "n1", "1731200000", body.replace("0x10", "0x11"), sig)).toBe(false);
    expect(verifyQuickNodeSignature(TOKEN, "n2", "1731200000", body, sig)).toBe(false);
    expect(verifyQuickNodeSignature("wrong-token", "n1", "1731200000", body, sig)).toBe(false);
    expect(verifyQuickNodeSignature(TOKEN, "", "", body, "")).toBe(false);
  });
});

describe("decoding Dharma events", () => {
  it("finds logs in any payload shape and decodes them", () => {
    for (const shape of [[approvalLog()], { data: [approvalLog()] }, { data: [[approvalLog()]] }, { dharmaLogs: [approvalLog()] }, { data: { dharmaLogs: [approvalLog()] } }]) {
      const events = decodeDharmaLogs(extractLogs(shape), new Set([ORG]), "quicknode");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event: "ApprovalRequested", contract: ORG, block: 16, source: "quicknode" });
      expect(events[0].args).toMatchObject({ agent: "ops-agent", amountUsd: 900 });
    }
  });

  it("drops events from other organizations' Dharma contracts", () => {
    expect(decodeDharmaLogs([approvalLog(OTHER_ORG)], new Set([ORG]), "rpc")).toEqual([]);
    expect(decodeDharmaLogs([approvalLog()], new Set(), "rpc")).toEqual([]); // org unknown → nothing
  });

  it("decodes who froze everything", () => {
    const [e] = decodeDharmaLogs([frozenLog("0x00000000000000000000000000000000000000aa")], new Set([ORG]), "rpc");
    expect(e.event).toBe("AgentFrozen");
    expect(String(e.args.by).toLowerCase()).toBe("0x00000000000000000000000000000000000000aa");
  });
});

describe("the QuickNode filter function (runs on QuickNode)", () => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const main = new Function(`${quickNodeFilterSource()}; return main;`)() as (s: unknown) => unknown;
  const noise = { address: OTHER_ORG, topics: [`0x${"99".repeat(32)}`], data: "0x" };

  it("keeps only Dharma events, whatever the input shape", () => {
    expect(main({ data: [[noise, approvalLog()]] })).toEqual({ dharmaLogs: [expect.objectContaining({ address: ORG })] });
    expect(main(JSON.stringify([approvalLog(), noise]))).toEqual({ dharmaLogs: [expect.objectContaining({ address: ORG })] });
    expect(main({ data: [noise] })).toBeNull();
  });
});

describe("relay", () => {
  it("relays each event once even when QuickNode and RPC both see it", () => {
    const relay = new Relay({ securityToken: TOKEN, dharma: () => ORG });
    const got: string[] = [];
    relay.on("events", (es) => got.push(...es.map((e: { event: string }) => e.event)));
    relay.ingest(decodeDharmaLogs([approvalLog()], new Set([ORG]), "quicknode"));
    relay.ingest(decodeDharmaLogs([approvalLog()], new Set([ORG]), "rpc"));
    expect(got).toEqual(["ApprovalRequested"]);
  });

  it("webhook: verified deliveries are relayed; forged, replayed, and unconfigured ones are refused", async () => {
    const relay = new Relay({ securityToken: TOKEN, dharma: () => ORG });
    const server = webhookServer(relay).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/quicknode/webhook`;
    const body = JSON.stringify({ data: [[approvalLog()]] });
    const post = (headers: Record<string, string>, b: string | Uint8Array = body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: b as BodyInit });
    try {
      const ok = await post({ "x-qn-nonce": "a", "x-qn-timestamp": "1", "x-qn-signature": sign("a", "1", body) });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, events: 1 });
      expect(relay.mode()).toBe("quicknode");

      expect((await post({ "x-qn-nonce": "b", "x-qn-timestamp": "1", "x-qn-signature": sign("b", "1", body, "attacker") })).status).toBe(401);
      expect((await post({ "x-qn-nonce": "a", "x-qn-timestamp": "1", "x-qn-signature": sign("a", "1", body) })).status).toBe(409);

      const gz = new Uint8Array(gzipSync(Buffer.from(body)));
      const zipped = await post({ "content-encoding": "gzip", "x-qn-nonce": "c", "x-qn-timestamp": "2", "x-qn-signature": sign("c", "2", body) }, gz);
      expect(zipped.status).toBe(200); // signature is over the decoded body

      expect(relay.stats).toMatchObject({ deliveries: 2, rejected: 2, quickNodeEvents: 1 });
      const bare = new Relay({ dharma: () => ORG });
      expect(bare.handleDelivery({}, Buffer.from(body)).status).toBe(503);
    } finally {
      server.close();
    }
  });
});
