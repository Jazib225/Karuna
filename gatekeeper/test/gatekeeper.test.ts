// Gatekeeper ↔ Dharma, end to end, against the REAL contract on a local chain (anvil).
// Payments use a fake wallet; governance uses real signatures and real transactions.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { startAnvil } from "./anvil.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient, createTestClient, createWalletClient, defineChain, http,
  type Address, type Hex, type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  Kind, actionTypedData, encodeChange, paymentDecisionTypedData, type Change,
} from "@prekaruna/dharma";
import { Store } from "../src/store.ts";
import { SecretStore } from "../src/secrets.ts";
import { Gatekeeper, GatekeeperError, type SignedAction } from "../src/gatekeeper.ts";
import { ViemChainWriter, ChainError } from "../src/chain.ts";
import type { WalletBackend, X402Quote } from "../src/wallet.ts";

const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({
  id: 5042002, name: "anvil-arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
// anvil's first default account plays the org's Circle wallet (the Gatekeeper's address)
const GK_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const SELLER = "0x00000000000000000000000000000000000000bb" as Address;
const PAYEE = "0x00000000000000000000000000000000000000cc" as Address;

let anvil: ChildProcess;
let client: PublicClient;
const test = () => createTestClient({ chain, mode: "anvil", transport: http(RPC) });

beforeAll(async () => {
  client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
  anvil = await startAnvil(PORT);
}, 20_000);
afterAll(() => anvil?.kill());

class FakeWallet implements WalletBackend {
  price = 0.001;
  paid: { kind: string; amount: number; to: string }[] = [];
  async quoteX402(): Promise<X402Quote> {
    return { amountUsd: this.price, seller: SELLER, network: "eip155:5042002", scheme: "exact", transferMethod: "gateway" };
  }
  async payX402(_f: string, _u: string, _m: string, _b: string | undefined, maxUsd: number) {
    if (this.price > maxUsd) throw new Error("exceeds max");
    this.paid.push({ kind: "x402", amount: this.price, to: SELLER });
    return { response: { data: "paid data" }, transaction: "tx" };
  }
  async transfer(_f: string, to: string, amountUsd: number) {
    this.paid.push({ kind: "transfer", amount: amountUsd, to });
    return { txRef: "0xtx", raw: {} };
  }
  async balances() {
    return { usdc: "10", gateway: "1" };
  }
  async listWallets() {
    return [];
  }
}

// ---------------------------------------------------------------- per-test org

let gk: Gatekeeper;
let wallet: FakeWallet;
let dir: string;
let alice: PrivateKeyAccount;
let bob: PrivateKeyAccount;
const gkAccount = privateKeyToAccount(GK_KEY);

function makeGatekeeper(d: string) {
  const writer = new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client);
  return new Gatekeeper({ store: new Store(d), wallet, client, writerFor: () => writer, timelockSeconds: 60, anchorEvery: 1000 });
}

beforeEach(async () => {
  if (gk) await gk.idle(); // let the previous org's background writes land first
  dir = mkdtempSync(join(tmpdir(), "karuna-gk3-"));
  wallet = new FakeWallet();
  alice = privateKeyToAccount(generatePrivateKey());
  bob = privateKeyToAccount(generatePrivateKey());
  gk = makeGatekeeper(dir);
  await gk.setup({ orgName: "Test Org", memberName: "Alice", memberAddress: alice.address, walletAddress: gkAccount.address });
}, 30_000);

async function sign(who: PrivateKeyAccount, kind: number, change: Change, proposalId = 0, support = false): Promise<SignedAction> {
  const { op, data } = encodeChange(change);
  const nonce = await gk.nonceOf(who.address);
  const deadline = await chainDeadline();
  const signature = await who.signTypedData(
    actionTypedData(gk.org.dharma!.address as Address, 5042002, { kind, op, data, proposalId: BigInt(proposalId), support, nonce, deadline }),
  );
  return { kind, op, data, proposalId, support, signer: who.address, deadline: deadline.toString(), signature };
}
/** Tests fast-forward the chain clock, so deadlines follow chain time (≥ wall clock). */
async function chainDeadline() {
  const t = (await client.getBlock()).timestamp;
  const wall = BigInt(Math.floor(Date.now() / 1000));
  return (t > wall ? t : wall) + 600n;
}
const tighten = async (who: PrivateKeyAccount, c: Change) => gk.submitAction(await sign(who, Kind.Tighten, c));
const propose = async (who: PrivateKeyAccount, c: Change, label?: string) => gk.submitAction({ ...(await sign(who, Kind.Propose, c)), label });
const vote = async (who: PrivateKeyAccount, id: number, c: Change, support = true) => gk.submitAction(await sign(who, Kind.Vote, c, id, support));
async function waitTimelock() {
  await test().increaseTime({ seconds: 65 });
  await test().mine({ blocks: 1 });
  await gk.housekeeping(); // the Gatekeeper executes passed proposals itself
}
async function activateAgent(capUsd: number) {
  const { id, token } = gk.prepareAgent("Ops agent");
  await propose(alice, { op: "SetAgent", id, capUsd });
  // New agents start at Level 0; these tests set Level 0's limits to the agent's old allowance.
  await propose(alice, { op: "SetLevelLimits", level: 0, perPaymentUsd: capUsd, dailyUsd: capUsd });
  await waitTimelock();
  return { id, token };
}
async function addPayee(account: Address, category: string, name = "Payee") {
  await propose(alice, { op: "SetPayee", account, category }, name);
  await waitTimelock();
}
async function signDecision(who: PrivateKeyAccount, proposalId: string, payloadHash: string, approve: boolean) {
  const deadline = await chainDeadline();
  const h = (payloadHash.startsWith("0x") ? payloadHash : `0x${payloadHash}`) as Hex;
  const signature = await who.signTypedData(
    paymentDecisionTypedData(gk.org.dharma!.address as Address, 5042002, { proposalId, payloadHash: h, approve, deadline }),
  );
  return { approve, payloadHash: h, signer: who.address, deadline: deadline.toString(), signature };
}
const pending = () => gk.snapshot().proposals.filter((p) => p.status === "pending");

// ================================================================ tests

describe("setup deploys the org's own Dharma", () => {
  it("starts with one member, the default rules and domains, and no agents or payees", () => {
    const s = gk.snapshot();
    expect(s.setUp).toBe(true);
    expect(s.policy!.members).toEqual([{ address: alice.address.toLowerCase(), name: "Alice" }]);
    expect(s.policy!.rules).toHaveLength(13);
    expect(s.policy!.domains).toEqual(["github.com", "stripe.com", "pypi.org", "npmjs.com"]);
    expect(s.policy!.agents).toEqual([]);
    expect(s.policy!.payees).toEqual([]);
  });

  it("names stay off-chain", async () => {
    const { id } = gk.prepareAgent("Secret project agent");
    await propose(alice, { op: "SetAgent", id, capUsd: 1 });
    const onchain = JSON.stringify(gk.policy);
    expect(onchain).not.toContain("Alice");
    expect(onchain).not.toContain("Secret project");
  });
});

describe("Rule changes: every member edit is voted on; only panic is instant", () => {
  it("a member's block rule can't be applied instantly — it's proposed, then applies after the vote and the wait", async () => {
    const { token } = await activateAgent(10);
    await addPayee(SELLER, "data");
    const agent = gk.authenticateAgent(token)!;
    expect((await gk.propose(agent, { type: "x402", url: "http://seller.test/x" })).status).toBe("done");

    const rule: Change = { op: "AddRule", id: "no-data", outcome: "Deny", agent, scope: "payment:data" };
    await expect(tighten(alice, rule)).rejects.toThrow(/go to a vote/);
    await propose(alice, rule);
    expect((await gk.propose(agent, { type: "x402", url: "http://seller.test/x" })).status).toBe("done"); // not yet
    await waitTimelock();
    const r = await gk.propose(agent, { type: "x402", url: "http://seller.test/x" });
    expect(r.status).toBe("denied");
    expect(gk.snapshot().proposals[0].decision.ruleId).toBe("no-data");
    expect(wallet.paid).toHaveLength(2);
  }, 30_000);

  it("removing a rule only works after the vote and the wait", async () => {
    await gk.submitAction({ ...(await sign(bob, Kind.Propose, { op: "AddMember", member: bob.address })), signer: bob.address }).catch(() => undefined);
    await propose(alice, { op: "AddMember", member: bob.address }, "Bob"); // 1 of 1 → queued
    await waitTimelock();
    expect(gk.snapshot().policy!.members).toHaveLength(2);

    const add: Change = { op: "AddRule", id: "no-data", outcome: "Deny", scope: "payment:data" };
    const added = await propose(bob, add);
    await vote(alice, added.proposalId!, add);
    await waitTimelock();
    const removal: Change = { op: "RemoveRule", id: "no-data" };
    const { proposalId } = await propose(alice, removal);
    const prop = () => gk.snapshot().policy!.proposals.find((p) => p.id === proposalId)!;
    expect(prop().status).toBe("open"); // 1 of 2 votes

    await waitTimelock(); // time alone doesn't pass it
    expect(gk.snapshot().policy!.rules.find((r) => r.id === "no-data")!.active).toBe(true);

    await vote(bob, proposalId!, removal);
    expect(prop().status).toBe("queued");
    await gk.housekeeping(); // timelock not elapsed yet
    expect(gk.snapshot().policy!.rules.find((r) => r.id === "no-data")!.active).toBe(true);

    await waitTimelock();
    expect(prop().status).toBe("executed");
    expect(gk.snapshot().policy!.rules.find((r) => r.id === "no-data")!.active).toBe(false);
  }, 60_000);

  it("when every member votes yes, the Gatekeeper applies a normal change right away", async () => {
    await propose(alice, { op: "AddMember", member: bob.address }, "Bob");
    await waitTimelock();
    const domain: Change = { op: "AddDomain", domain: "example.org" };
    await propose(alice, domain);
    const id = gk.snapshot().policy!.proposals.find((x) => x.change?.op === "AddDomain")!.id;
    await vote(bob, id, domain); // 2 of 2: no wait
    await test().increaseTime({ seconds: 3 }); // only the Gatekeeper's few-second safety margin, not the 60 s wait
    await test().mine({ blocks: 1 });
    await gk.housekeeping();
    expect(gk.snapshot().policy!.domains).toContain("example.org");
  }, 30_000);

  it("a core rule changes only as a core change: every member, then the core wait (default 24 h)", async () => {
    await expect(tighten(alice, { op: "RemoveRule", id: "secrets-read" })).rejects.toThrow(/go to a vote/);
    await propose(alice, { op: "RemoveRule", id: "secrets-read" });
    const p = gk.snapshot().policy!.proposals.find((x) => x.change?.op === "RemoveRule")!;
    expect(p).toMatchObject({ core: true, needed: 1, status: "queued" });
    expect(p.eta! - p.queuedAt).toBe(86_400);
    await waitTimelock(); // the normal wait isn't enough
    expect(gk.snapshot().policy!.rules.find((r) => r.id === "secrets-read")!.active).toBe(true);
    await test().increaseTime({ seconds: 86_400 });
    await test().mine({ blocks: 1 });
    await gk.housekeeping();
    expect(gk.snapshot().policy!.rules.find((r) => r.id === "secrets-read")!.active).toBe(false);
  }, 30_000);

  it("a new agent can't act until Dharma adds it", async () => {
    const { id, token } = gk.prepareAgent("Waiting agent");
    expect(gk.authenticateAgent(token)).toBe(id);
    await expect(gk.propose(id, { type: "action", tool: "shell", command: "ls" })).rejects.toThrow(/not active/);
    await propose(alice, { op: "SetAgent", id, capUsd: 1 });
    await expect(gk.propose(id, { type: "action", tool: "shell", command: "ls" })).rejects.toThrow(/not active/);
    await waitTimelock();
    expect((await gk.propose(id, { type: "action", tool: "shell", command: "ls" })).status).toBe("allowed");
  }, 30_000);
});

describe("nobody can act without a member's signature", () => {
  it("a non-member's signature is refused", async () => {
    const mallory = privateKeyToAccount(generatePrivateKey());
    await expect(tighten(mallory, { op: "Freeze" })).rejects.toThrow(/not a Dharma member/);
  });

  it("a signature for one change can't be used for another", async () => {
    const signed = await sign(alice, Kind.Propose, { op: "SetPayee", account: PAYEE, category: "data" });
    const swapped = encodeChange({ op: "SetPayee", account: SELLER, category: "data" });
    await expect(gk.submitAction({ ...signed, data: swapped.data })).rejects.toThrow(/Signature does not match/);
  });

  it("the Gatekeeper's own key can tighten but never loosen", async () => {
    const writer = new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client);
    const { op, data } = encodeChange({ op: "SetPayee", account: PAYEE, category: "x" });
    await expect(writer.write(gk.org.dharma!.address as Address, "tighten", [op, data, "0x0000000000000000000000000000000000000000", 0n, "0x"]))
      .rejects.toBeInstanceOf(ChainError);
  });
});

describe("payment approvals are signed by members (Exact Match)", () => {
  it("a member's signature on the payload hash pays exactly that", async () => {
    const { token } = await activateAgent(0);
    await addPayee(PAYEE, "services");
    const r = await gk.propose(gk.authenticateAgent(token)!, { type: "transfer", to: PAYEE, amountUsd: 5 });
    expect(r.status).toBe("pending");
    const p = pending()[0];
    expect((await gk.decide(p.id, await signDecision(alice, p.id, p.payloadHash!, true))).status).toBe("executed");
    expect(wallet.paid).toEqual([{ kind: "transfer", amount: 5, to: PAYEE }]);
  }, 30_000);

  it("approving a different payload hash is refused; nothing paid", async () => {
    const { token } = await activateAgent(0);
    await addPayee(PAYEE, "services");
    await gk.propose(gk.authenticateAgent(token)!, { type: "transfer", to: PAYEE, amountUsd: 5 });
    const p = pending()[0];
    await expect(gk.decide(p.id, await signDecision(alice, p.id, "ab".repeat(32), true))).rejects.toThrow(/Exact Match failed/);
    expect(wallet.paid).toEqual([]);
  }, 30_000);

  it("seller raises the price after approval → refused", async () => {
    const { token } = await activateAgent(0);
    await addPayee(SELLER, "data");
    await gk.propose(gk.authenticateAgent(token)!, { type: "x402", url: "http://seller.test/x" });
    const p = pending()[0];
    wallet.price = 0.002;
    const r = await gk.decide(p.id, await signDecision(alice, p.id, p.payloadHash!, true));
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/Seller now asks/);
    expect(wallet.paid).toEqual([]);
  }, 30_000);

  it("two-person approval needs two different members' keys", async () => {
    await propose(alice, { op: "AddMember", member: bob.address }, "Bob");
    await waitTimelock();
    const lower: Change = { op: "SetThreshold", usd: 2 }; // even lowering it is voted on
    const t = await propose(bob, lower);
    await vote(alice, t.proposalId!, lower);
    await waitTimelock();
    const { id, token } = gk.prepareAgent("Ops agent");
    const add: Change = { op: "SetAgent", id, capUsd: 0 };
    const { proposalId } = await propose(alice, add);
    await vote(bob, proposalId!, add);
    await addPayeeTwo();
    await gk.propose(gk.authenticateAgent(token)!, { type: "transfer", to: PAYEE, amountUsd: 3 });
    const p = pending()[0];
    expect((await gk.decide(p.id, await signDecision(alice, p.id, p.payloadHash!, true))).status).toBe("needs-another-approval");
    await expect(gk.decide(p.id, await signDecision(alice, p.id, p.payloadHash!, true))).rejects.toThrow(/already approved/);
    expect(wallet.paid).toEqual([]);
    expect((await gk.decide(p.id, await signDecision(bob, p.id, p.payloadHash!, true))).status).toBe("executed");

    async function addPayeeTwo() {
      const c: Change = { op: "SetPayee", account: PAYEE, category: "services" };
      const r = await propose(alice, c, "Payee");
      await vote(bob, r.proposalId!, c);
      await waitTimelock();
    }
  }, 60_000);
});

describe("panic button", () => {
  it("one member freezes instantly; unfreezing goes through a vote and the timelock", async () => {
    const { token } = await activateAgent(10);
    const agent = gk.authenticateAgent(token)!;
    await tighten(alice, { op: "Freeze" });
    expect(gk.snapshot().policy && gk.policy!.frozen).toBe(true);
    expect((await gk.propose(agent, { type: "action", tool: "shell", command: "ls" })).status).toBe("denied");

    await propose(alice, { op: "Unfreeze" });
    expect(gk.policy!.frozen).toBe(true); // still frozen until the timelock passes
    await waitTimelock();
    expect(gk.policy!.frozen).toBe(false);
    expect((await gk.propose(agent, { type: "action", tool: "shell", command: "ls" })).status).toBe("allowed");
  }, 30_000);
});

describe("nothing is erasable", () => {
  it("the log head is anchored on Dharma and can't be rewound", async () => {
    await activateAgent(1);
    await gk.anchorNow();
    expect(gk.policy!.logLength).toBe(gk.log.length);
    expect(gk.policy!.logHead).toBe(`0x${gk.log.head()}`);
  }, 30_000);

  it("a restarted Gatekeeper resumes from disk + chain; an edited log refuses to start", async () => {
    await activateAgent(1);
    const again = makeGatekeeper(dir);
    await again.sync();
    expect(again.log.length).toBe(gk.log.length);
    expect(again.policy!.agents).toHaveLength(1);

    const path = join(dir, "log.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const e = JSON.parse(lines[0]);
    e.event.firstMember = bob.address;
    lines[0] = JSON.stringify(e);
    writeFileSync(path, lines.join("\n") + "\n");
    expect(() => makeGatekeeper(dir)).toThrow(/failed verification/);
  }, 30_000);
});

describe("agents still never see reasons", () => {
  it("unknown recipient → blank denial", async () => {
    const { token } = await activateAgent(10);
    const r = await gk.propose(gk.authenticateAgent(token)!, { type: "transfer", to: PAYEE, amountUsd: 1 });
    expect(r).toEqual({ id: r.id, status: "denied" });
    expect(GatekeeperError).toBeDefined();
  }, 30_000);
});

const bodies = (agentId: string) => gk.agentInbox(agentId).map((m: { body: string }) => m.body);

describe("rules cover every kind of action, not just payments and web requests", () => {
  it("a shell rule blocks the command for the agent it names, after the vote", async () => {
    const a = await activateAgent(1);
    const agent = gk.authenticateAgent(a.token)!;
    await propose(alice, { op: "AddRule", id: "no-push", outcome: "Deny", agent, scope: "shell", target: "git push" });
    await waitTimelock();
    expect((await gk.propose(agent, { type: "action", tool: "shell", command: "git push origin main" })).status).toBe("denied");
    expect(gk.snapshot().proposals.at(-1)!.decision.ruleId).toBe("no-push");
  }, 30_000);

  it("message rules: a block stops it; an approval rule holds it, and only the approved message is delivered", async () => {
    const research = gk.authenticateAgent((await activateAgent(1)).token)!;
    const payer = gk.authenticateAgent((await activateAgent(1)).token)!;
    // No rule of the org's own: at Level 0 a message waits for approval…
    const first = await gk.propose(research, { type: "message", to: payer, body: "hello" });
    expect(first.status).toBe("pending");
    expect(pending()[0].decision.ruleId).toBe("level-messages");
    expect(bodies(payer)).toEqual([]);
    await gk.decide(pending()[0].id, await signDecision(alice, pending()[0].id, pending()[0].payloadHash!, true));
    expect(bodies(payer)).toEqual(["hello"]);
    // …and from Level 1 it's delivered.
    gk.setChainRecords({ records: { [research]: { agent: research, level: 0, cleanStreak: 10 } } });
    await propose(alice, { op: "SetLevel", agent: research, level: 1, reason: "vote" });
    await waitTimelock();
    expect((await gk.propose(research, { type: "message", to: payer, body: "hello again" })).status).toBe("allowed");
    expect(bodies(payer)).toEqual(["hello again", "hello"]); // newest first

    await propose(alice, { op: "AddRule", id: "dm-needs-ok", outcome: "Approval", agent: research, scope: "message", target: payer });
    await waitTimelock();
    const held = await gk.propose(research, { type: "message", to: payer, body: "please pay invoice 7" });
    expect(held.status).toBe("pending");
    expect(bodies(payer)).toHaveLength(2); // not delivered yet
    const p = pending()[0];
    expect(p.decision.ruleId).toBe("dm-needs-ok");
    await gk.decide(p.id, await signDecision(alice, p.id, p.payloadHash!, true));
    expect(bodies(payer)).toContain("please pay invoice 7");

    await propose(alice, { op: "AddRule", id: "dm-blocked", outcome: "Deny", agent: research, scope: "message", target: payer });
    await waitTimelock();
    expect((await gk.propose(research, { type: "message", to: payer, body: "again" })).status).toBe("denied");
    expect(bodies(payer)).not.toContain("again");
  }, 60_000);
});

describe("plain-English rules: a draft that worked is saved and reused", () => {
  it("the same sentence comes back from the saved draft with no model call, and new rule ids", async () => {
    await activateAgent(1);
    const secrets = new SecretStore(dir);
    secrets.put("gemini", "GEMINI_API_KEY", "test-key");
    const g = new Gatekeeper({ store: new Store(dir), wallet, client, writerFor: () => new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client), timelockSeconds: 60, anchorEvery: 1000, secrets });
    await g.housekeeping();
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      const content = JSON.stringify({ rules: [{ kind: "shell", outcome: "deny", agent: "", target: "git push", method: "", fileOp: "", category: "", maxUsd: 0 }], note: "" });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const first = await g.draftRules("Nobody runs git push");
      expect(first.model).toBe("gemini-3.8-flash");
      const again = await g.draftRules("  nobody runs   GIT push ");
      expect(again.model).toBe("saved");
      expect(calls).toBe(1); // no second model call
      expect(again.rules.map((r) => r.sentence)).toEqual(first.rules.map((r) => r.sentence));
      expect(again.rules[0].change.id).not.toBe(first.rules[0].change.id);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 30_000);
});
