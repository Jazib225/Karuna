import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { DHARMA_ABI, levelUpEligibility, toBytes32 } from "@prekaruna/dharma";
import {
  TRANSFER_TOPIC, decodeDharmaLogs, decodeWalletTransfers, extractLogs, quickNodeFilterSource, quickNodeWatchdogFilterSource, type RawLog,
} from "../src/events.ts";
import { RecordBook } from "../src/records.ts";
import { Relay } from "../src/relay.ts";

const ORG = "0x00000000000000000000000000000000000000d1";
const WALLET = "0xe78f1b83b5f995a8c5fbc3b4ad1f3639fe6002ea";
const PAYEE = "0x00000000000000000000000000000000000000a1";
const A = "research";

let n = 0;
function log(eventName: string, args: Record<string, unknown>, block: number, data: { types: { type: string }[]; values: unknown[] } = { types: [], values: [] }): RawLog {
  const topics = encodeEventTopics({ abi: DHARMA_ABI, eventName, args } as never) as string[];
  return {
    address: ORG, topics, data: data.types.length ? encodeAbiParameters(data.types, data.values) : "0x",
    blockNumber: block, transactionHash: `0x${(++n).toString(16).padStart(64, "0")}`, logIndex: 0,
  };
}
const agent = toBytes32(A);
const actions = (completed: number, denied: number, block: number) =>
  log("ActionsRecorded", { agent }, block, { types: [{ type: "uint64" }, { type: "uint64" }], values: [BigInt(completed), BigInt(denied)] });
const levelSet = (level: number, reason: string, block: number) =>
  log("LevelSet", { agent, by: ORG }, block, { types: [{ type: "uint8" }, { type: "string" }], values: [level, reason] });
const tripwire = (block: number) => log("TripwireFired", { agent }, block, { types: [{ type: "string" }], values: ["trap password"] });
const drill = (block: number) => log("TestFailed", { agent }, block, { types: [{ type: "string" }], values: ["supplies"] });
const decode = (logs: RawLog[], source: "quicknode" | "rpc" = "quicknode") => decodeDharmaLogs(logs, new Set([ORG]), source);

describe("agent records (trust levels), from Dharma's events", () => {
  it("counts the running totals and the clean streak since the last level change or incident", () => {
    const book = new RecordBook();
    book.useDharma(ORG);
    book.add(decode([actions(4, 1, 10), levelSet(1, "vote", 11), actions(9, 1, 20), actions(16, 2, 30)]));
    const r = book.records()[A];
    expect(r).toMatchObject({ level: 1, completed: 16, denied: 2, cleanStreak: 12, tripwires: 0 });
    expect(levelUpEligibility(r, 1)).toMatchObject({ eligible: false, target: 2, needed: 25, have: 12 });
    book.add(decode([drill(31), actions(18, 2, 40)]));
    expect(book.records()[A]).toMatchObject({ drillsFailed: 1, cleanStreak: 2 });
    book.add(decode([tripwire(41), levelSet(0, "tripwire", 41)]));
    expect(book.records()[A]).toMatchObject({ level: 0, tripwires: 1, cleanStreak: 0 });
    expect(book.records()[A].levelChanges.map((c) => c.reason)).toEqual(["vote", "tripwire"]);
  });

  it("the same events in any order, or twice, give the same record", () => {
    const events = decode([actions(4, 0, 10), levelSet(1, "vote", 11), actions(15, 0, 20)]);
    const inOrder = new RecordBook();
    inOrder.add(events);
    const shuffled = new RecordBook();
    shuffled.add([events[2], events[0]]);
    shuffled.add([events[1], events[2], events[0]]); // a backfill re-delivering what live already sent
    expect(shuffled.records()).toEqual(inOrder.records());
    expect(shuffled.size).toBe(3);
  });

  it("the record says where it came from, and a new org starts empty", () => {
    const book = new RecordBook();
    book.useDharma(ORG);
    book.add(decode([actions(1, 0, 5)], "rpc"));
    expect(book.source()).toBe("rpc");
    book.add(decode([actions(2, 0, 6)], "quicknode"));
    expect(book.source()).toBe("quicknode");
    book.useDharma("0x00000000000000000000000000000000000000d9");
    expect(book.size).toBe(0);
  });

  it("the relay pushes rebuilt records to the Gatekeeper", async () => {
    const sent: unknown[] = [];
    const relay = new Relay({ dharma: () => ORG, records: new RecordBook(), notifyRecords: async (r) => void sent.push(r) });
    relay.ingest(decode([actions(3, 0, 5)]));
    await new Promise((r) => setTimeout(r, 600));
    expect(sent).toEqual([{ [A]: expect.objectContaining({ completed: 3 }) }]);
  });

  it("the backfilled Stream's filter still forwards the new v3 events", () => {
    const run = new Function(`${quickNodeFilterSource()}; return main;`)() as (s: unknown) => { dharmaLogs: RawLog[] } | null;
    const out = run({ data: [[actions(1, 0, 5), levelSet(1, "vote", 6), tripwire(7)]] });
    expect(decode(extractLogs(out)).map((e) => e.event)).toEqual(["ActionsRecorded", "LevelSet", "TripwireFired"]);
  });
});

// ---------------------------------------------------------------- wallet watchdog

const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const transfer = (emitter: string, from: string, to: string, value: bigint, hash = 7): RawLog => ({
  address: emitter, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: encodeAbiParameters([{ type: "uint256" }], [value]),
  blockNumber: "0x20", transactionHash: `0x${hash.toString(16).padStart(64, "0")}`, logIndex: "0x1",
});
const ERC20 = "0x3600000000000000000000000000000000000000";
const NATIVE = "0xfffffffffffffffffffffffffffffffffffffffe";

describe("wallet watchdog (QuickNode Stream on USDC transfers)", () => {
  it("decodes USDC leaving the wallet from either emitter, at the right decimals, once per transfer", () => {
    const out = decodeWalletTransfers([transfer(ERC20, WALLET, PAYEE, 1_500_000n), transfer(NATIVE, WALLET, PAYEE, 1_500_000_000_000_000_000n)], WALLET, "quicknode");
    expect(out).toEqual([{ id: `0x${"7".padStart(64, "0")}:${PAYEE}:1500000`, txHash: `0x${"7".padStart(64, "0")}`, to: PAYEE, amountUsd: 1.5, block: 32, source: "quicknode" }]);
  });

  it("ignores transfers into the wallet, from other wallets, and from other tokens", () => {
    const other = "0x00000000000000000000000000000000000000b2";
    expect(decodeWalletTransfers([
      transfer(ERC20, PAYEE, WALLET, 1n), transfer(ERC20, other, PAYEE, 1n), transfer("0x00000000000000000000000000000000000000c3", WALLET, PAYEE, 1n),
    ], WALLET, "rpc")).toEqual([]);
  });

  it("the Stream filter keeps exactly those transfers, and the relay reports each once", async () => {
    const run = new Function(`${quickNodeWatchdogFilterSource(WALLET)}; return main;`)() as (s: unknown) => unknown;
    const block = { data: [{ logs: [transfer(ERC20, WALLET, PAYEE, 2_000_000n, 9), transfer(ERC20, PAYEE, WALLET, 5n, 10)] }] };
    const filtered = run(block) as { walletTransfers: RawLog[] };
    expect(filtered.walletTransfers).toHaveLength(1);
    expect(run({ data: [] })).toBeNull();

    const reported: unknown[] = [];
    const relay = new Relay({ dharma: () => ORG, wallet: () => WALLET, notifyTransfers: async (t) => void reported.push(...t) });
    const t = decodeWalletTransfers(extractLogs(filtered), WALLET, "quicknode");
    relay.ingestTransfers(t);
    relay.ingestTransfers(decodeWalletTransfers(extractLogs(filtered), WALLET, "rpc")); // the safety net sees it too
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ to: PAYEE, amountUsd: 2 });
  });
});

// Guard against an accidental ABI drift: the record reads these events by name.
it("Dharma's ABI has every event the record reads", () => {
  const names = DHARMA_ABI.filter((x) => x.type === "event").map((x) => (x as { name: string }).name);
  for (const e of ["ActionsRecorded", "LevelSet", "TripwireFired", "TestFailed", "ApprovalRequested", "UnapprovedTransfer"]) expect(names).toContain(e);
  expect((`0x${"00".repeat(32)}` as Hex).length).toBe(66);
});
