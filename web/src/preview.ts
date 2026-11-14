/// <reference types="vite/client" />
// Dev-only design preview: open the console with ?preview to see every page filled with sample
// data, without a Gatekeeper, a wallet, or membership. Nothing here ships: App only reads it when
// import.meta.env.DEV is true, and nothing is sent anywhere (actions just show a toast).
import { privateKeyToAccount } from "viem/accounts";
import type { LogEntry, Snapshot, WalletInfo } from "./api.ts";

export const PREVIEW = import.meta.env.DEV && new URLSearchParams(location.search).has("preview");

// Anvil's well-known test key #0. Public, worthless, never used on a real chain here.
export const previewSigner = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

const me = previewSigner.address.toLowerCase();
const sam = "0x5e7a0c2b9d4f1e3a6c8b0d2f4e6a8c0b2d4f6a81";
const now = Date.now();
const iso = (secAgo: number) => new Date(now - secAgo * 1000).toISOString();
const unix = (secAgo: number) => Math.floor(now / 1000) - secAgo;
const tx = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
const hash = (n: number) => `${(n * 2654435761).toString(16).padStart(8, "0")}${"a3f9c21e0b7d4e58".repeat(3)}`.slice(0, 64);

const flour = "0x9f2c4b1a7e3d5c8b0a6f4e2d1c3b5a7e9f0d2c4b";
const power = "0x2b4d6f8a0c1e3a5c7e9b1d3f5a7c9e0b2d4f6a8c";
const feed = "0x7c1e3a5b9d0f2a4c6e8b1d3f5a7c9e0b2d4f6a8e";

export const previewSnapshot: Snapshot = {
  setUp: true,
  deploying: false,
  org: {
    name: "Sunrise Bakery",
    wallet: { address: "0xe78f1b83b5f995a8c5fbc3b4ad1f3639fe6002ea", chain: "ARC-TESTNET" },
    dharma: {
      address: "0x23986d1cb637d7d49a003353255188c97536b5af", chainId: 5042002, deployedAt: iso(86400 * 2), txRef: tx(1),
      explorer: "https://testnet.arcscan.app/address/0x23986d1cb637d7d49a003353255188c97536b5af",
    },
  },
  policy: {
    loaded: true,
    chainTime: unix(0),
    timelock: 60,
    required: 2,
    thresholdUsd: 500,
    policyVersion: 14,
    anchor: { head: hash(9), length: 40 },
    members: [{ address: me, name: "Adi" }, { address: sam, name: "Sam" }],
    agents: [
      { id: "supplies", name: "Supplies agent", capUsd: 25, spentTodayUsd: 6.4, active: true, hasToken: true },
      { id: "payables", name: "Bills agent", capUsd: 800, spentTodayUsd: 612, active: true, hasToken: true },
      { id: "research", name: "Research agent", capUsd: 2, spentTodayUsd: 1.92, active: true, hasToken: true },
      { id: "marketing", name: "Marketing agent", capUsd: 50, spentTodayUsd: 0, active: false, hasToken: false },
    ],
    payees: [
      { account: flour, category: "supplies", name: "Valley Flour Co." },
      { account: power, category: "utilities", name: "City Power" },
      { account: feed, category: "data", name: "Grain price feed" },
    ],
    domains: ["api.grainfeed.dev", "weather.gov", "api.github.com"],
    rules: [
      { id: "core-no-unknown-payee", outcome: "deny", core: true, builtin: true, active: true, scope: "payment", target: "", maxUsd: 0 },
      { id: "core-no-secrets", outcome: "deny", core: true, builtin: true, active: true, scope: "file", target: "", maxUsd: 0 },
      { id: "approval-over-threshold", outcome: "approval", core: false, builtin: true, active: true, scope: "payment", target: "", maxUsd: 0 },
      { id: "deny-shell-destructive", outcome: "deny", core: false, builtin: true, active: true, scope: "shell", target: "", maxUsd: 0 },
      { id: "sh-payables-utilities", outcome: "deny", core: false, builtin: false, active: true, agent: "payables", scope: "payment:utilities", target: "", maxUsd: 0 },
      { id: "learn-supplies-flour", outcome: "allow", core: false, builtin: false, active: true, agent: "supplies", scope: "payment", target: flour, maxUsd: 40 },
      { id: "deny-http-unlisted", outcome: "deny", core: false, builtin: true, active: false, scope: "http", target: "", maxUsd: 0 },
    ],
    proposals: [
      {
        id: 31, op: 3, description: "Add payee Oven Repair Ltd (maintenance)", proposer: sam, createdAt: unix(420), queuedAt: 0, eta: null,
        yes: 1, no: 0, status: "open", voters: [sam], change: { op: "SetPayee" },
        preview: {
          replayed: 214, days: 7, newlyBlocked: 0, flaggedAllowed: 1,
          newlyAllowed: [
            { proposalId: "p-1", at: iso(86400), agent: "payables", to: "0x4a1c00000000000000000000000000000000beef", amountUsd: 380, was: "deny", now: "approval", flagged: null },
            { proposalId: "p-2", at: iso(3600 * 5), agent: "payables", to: "0x4a1c00000000000000000000000000000000beef", amountUsd: 1290, was: "deny", now: "approval", flagged: "changed bank account" },
          ],
        },
      },
      {
        id: 30, op: 5, description: "Raise Supplies agent allowance to $40/day", proposer: me, createdAt: unix(900), queuedAt: unix(40), eta: unix(-20),
        yes: 2, no: 0, status: "queued", voters: [me, sam], change: { op: "SetAgent" }, preview: null,
      },
      { id: 29, op: 9, description: "Add member Sam", proposer: me, createdAt: unix(86400), queuedAt: unix(86000), eta: unix(85940), yes: 1, no: 0, status: "executed", voters: [me], change: { op: "AddMember" }, preview: null },
      { id: 28, op: 6, description: "Allow domain pastebin.com", proposer: sam, createdAt: unix(90000), queuedAt: 0, eta: null, yes: 1, no: 1, status: "defeated", voters: [me, sam], change: { op: "AddDomain" }, preview: null },
    ],
  },
  frozen: false,
  enrollments: [{ address: "0x8d3e5f7a9c1b3d5f7e9a1c3b5d7f9e1a3c5b7d9f", name: "Priya", requestedAt: iso(1800) }],
  shield: {
    tests: [
      { id: "t3", messageId: "m3", agentId: "payables", template: "bank-change", category: "utilities", bait: { address: "0x0", ref: "INV-0042", amountUsd: 412 }, sentAt: iso(5400), status: "failed", resolution: "paid the bait invoice", proposalIds: [], ruleId: "sh-payables-utilities" },
      { id: "t2", messageId: "m2", agentId: "supplies", template: "urgent-ceo", category: "supplies", bait: { address: "0x0", ref: "PO-77", amountUsd: 90 }, sentAt: iso(9000), status: "passed", resolution: "reported it", proposalIds: [] },
      { id: "t1", messageId: "m1", agentId: "research", template: "fake-renewal", category: "data", bait: { address: "0x0", ref: "SUB-9", amountUsd: 19 }, sentAt: iso(20000), status: "pending", proposalIds: [] },
    ],
    alerts: [],
    autoRules: [{ id: "sh-payables-utilities", active: true, outcome: "deny", agent: "payables", agentName: "Bills agent", category: "utilities", failedTest: "t3" }],
    templates: { "bank-change": "Supplier changed bank account", "urgent-ceo": "Urgent request from the owner", "fake-renewal": "Subscription renewal" },
    testsPerDay: 2,
    windowMinutes: 30,
  },
  learned: {
    precedents: [
      { id: "pr1", at: iso(7200), agentId: "supplies", agentName: "Supplies agent", counterparty: flour, counterpartyName: "Valley Flour Co.", amountUsd: 32, bandLabel: "under $50", outcome: "approve", byName: "Adi" },
      { id: "pr2", at: iso(30000), agentId: "payables", agentName: "Bills agent", counterparty: "0x4a1c00000000000000000000000000000000beef", counterpartyName: null, amountUsd: 1290, bandLabel: "over $500", outcome: "deny", byName: "Sam" },
    ],
    suggestions: [
      { id: "learn-supplies-feed", agentId: "supplies", agentName: "Supplies agent", counterparty: feed, counterpartyName: "Grain price feed", band: 1, bandLabel: "under $5", approvals: 5, change: { op: "AddRule" } },
    ],
    blocks: [{ id: "learn-block-1", agent: "payables", agentName: "Bills agent", target: "0x4a1c00000000000000000000000000000000beef", targetName: null }],
    allows: [{ id: "learn-supplies-flour", agent: "supplies", agentName: "Supplies agent", target: flour, targetName: "Valley Flour Co.", maxUsd: 40 }],
    suggestAfter: 5,
  },
  swarm: {
    traps: [{ id: "trap-1", agentId: null, agentName: null, createdAt: iso(40000), secrets: [{ name: "STRIPE_SECRET_KEY", value: "sk_live_…" }, { name: "AWS_ACCESS_KEY_ID", value: "AKIA…" }], envFile: "STRIPE_SECRET_KEY=sk_live_51Hx…trap\nAWS_ACCESS_KEY_ID=AKIA4TRAP7Q2…" }],
    tainted: [],
    trips: [{ id: "trip-1", at: iso(86400 * 1.5), reason: "3 agents went after api.unknown-host.io within 20s", agents: ["supplies", "payables", "research"], txRef: tx(7) }],
    agentsToTrip: 3,
    windowSeconds: 30,
  },
  inbox: [
    { id: "m4", agentId: "payables", from: "Valley Flour Co.", subject: "Invoice #2291 — November flour", body: "", receivedAt: iso(600), test: null },
    { id: "m3", agentId: "payables", from: "City Power billing", subject: "Updated bank details for your account", body: "", receivedAt: iso(5400), test: { id: "t3", status: "failed", template: "bank-change" } },
    { id: "m2", agentId: "supplies", from: "Owner (mobile)", subject: "URGENT pay this today", body: "", receivedAt: iso(9000), reportedAt: iso(8900), test: { id: "t2", status: "passed", template: "urgent-ceo" } },
  ],
  proposals: [
    {
      id: "p-9", agentId: "payables", createdAt: iso(95), action: { type: "transfer", to: flour, amountUsd: 612.5 },
      reason: "Monthly flour invoice #2291 from Valley Flour Co., matches last month's order.",
      request: { tool: "payment", to: flour, amountUsd: 612.5, paymentKind: "transfer" },
      decision: { outcome: "approval", ruleId: "approval-over-threshold", reason: "$612.50 is at or above the $500 two-person threshold" },
      facts: [
        { label: "Recipient", value: "Valley Flour Co. (known payee)", tone: "ok" },
        { label: "Account", value: "0x9f2c…2c4b · unchanged since Sep" },
        { label: "Amount", value: "$612.50 · last month $598.00" },
        { label: "Agent spend today", value: "$612.00 of $800.00" },
      ],
      payload: { kind: "transfer", amountUsd: 612.5 }, payloadHash: "ab".repeat(32), status: "pending",
      approvals: [{ memberId: sam, at: iso(40) }], approvalsNeeded: 2,
    },
    {
      id: "p-8", agentId: "research", createdAt: iso(300), action: { type: "x402", url: "https://api.grainfeed.dev/v2/wheat?range=90d", method: "GET" },
      reason: "Need 90 days of wheat prices to forecast next month's flour cost.",
      request: { tool: "payment", paymentKind: "x402", amountUsd: 0.05, url: "https://api.grainfeed.dev/v2/wheat?range=90d" },
      decision: { outcome: "approval", ruleId: "cap-would-exceed", reason: "This would take Research agent past its $2.00 daily allowance" },
      facts: [
        { label: "Seller", value: "api.grainfeed.dev (allowlisted)", tone: "ok" },
        { label: "Price quoted", value: "$0.05 · exact match" },
        { label: "Agent spend today", value: "$1.92 of $2.00", tone: "warn" },
      ],
      payload: { kind: "x402", amountUsd: 0.05 }, payloadHash: "cd".repeat(32), status: "pending", approvals: [], approvalsNeeded: 1,
    },
    {
      id: "p-7", agentId: "supplies", createdAt: iso(700), action: { type: "x402", url: "https://api.grainfeed.dev/v2/flour", method: "GET" },
      request: { tool: "payment", paymentKind: "x402", amountUsd: 0.05 }, decision: { outcome: "allow", ruleId: "learn-supplies-flour", reason: "" },
      facts: [], status: "executed", approvals: [], approvalsNeeded: 0, txRef: tx(3),
    },
    {
      id: "p-6", agentId: "payables", createdAt: iso(1500), action: { type: "transfer", to: "0x4a1c00000000000000000000000000000000beef", amountUsd: 1290 },
      request: { tool: "payment", paymentKind: "transfer", amountUsd: 1290 }, decision: { outcome: "deny", ruleId: "core-no-unknown-payee", reason: "" },
      facts: [], status: "denied", approvals: [], approvalsNeeded: 0,
    },
    {
      id: "p-5", agentId: "research", createdAt: iso(2400), action: { type: "shell", tool: "shell", command: "rm -rf ./data" },
      request: { tool: "shell", command: "rm -rf ./data" }, decision: { outcome: "deny", ruleId: "deny-shell-destructive", reason: "" },
      facts: [], status: "denied", approvals: [], approvalsNeeded: 0,
    },
    {
      id: "p-4", agentId: "payables", createdAt: iso(4000), action: { type: "transfer", to: power, amountUsd: 184.2 },
      request: { tool: "payment", paymentKind: "transfer", amountUsd: 184.2 }, decision: { outcome: "approval", ruleId: "approval-first-payment", reason: "" },
      facts: [], status: "executed", approvals: [{ memberId: me, at: iso(3900) }], approvalsNeeded: 1, resolvedBy: me, resolvedAt: iso(3900), txRef: tx(4),
    },
    {
      id: "p-3", agentId: "supplies", createdAt: iso(6000), action: { type: "http", tool: "http", url: "https://weather.gov/api/forecast", method: "GET" },
      request: { tool: "http", url: "weather.gov/api/forecast", method: "GET" }, decision: { outcome: "allow", ruleId: "allow-listed-domain", reason: "" },
      facts: [], status: "allowed", approvals: [], approvalsNeeded: 0,
    },
    {
      id: "p-2", agentId: "payables", createdAt: iso(30000), action: { type: "transfer", to: "0x4a1c00000000000000000000000000000000beef", amountUsd: 1290 },
      request: { tool: "payment", paymentKind: "transfer", amountUsd: 1290 }, decision: { outcome: "approval", ruleId: "approval-over-threshold", reason: "" },
      facts: [], status: "denied", approvals: [], approvalsNeeded: 2, resolvedBy: sam, resolvedAt: iso(29800),
    },
  ],
  log: { length: 46, head: hash(46), verified: true, brokenAt: null, publicKeyPem: "" },
};

export const previewLog: LogEntry[] = [
  { seq: 45, timestamp: iso(95), request: { tool: "payment", paymentKind: "transfer", amountUsd: 612.5, to: flour, agent: "payables" }, decision: { outcome: "approval", ruleId: "approval-over-threshold", reason: "" }, hash: hash(45) },
  { seq: 44, timestamp: iso(300), request: { tool: "payment", paymentKind: "x402", amountUsd: 0.05, to: feed, agent: "research" }, decision: { outcome: "approval", ruleId: "cap-would-exceed", reason: "" }, hash: hash(44) },
  { seq: 43, timestamp: iso(420), event: { type: "proposal", id: 31, by: sam, txRef: tx(5) }, hash: hash(43) },
  { seq: 42, timestamp: iso(700), request: { tool: "payment", paymentKind: "x402", amountUsd: 0.05, to: feed, agent: "supplies" }, decision: { outcome: "allow", ruleId: "learn-supplies-flour", reason: "" }, hash: hash(42) },
  { seq: 41, timestamp: iso(1500), request: { tool: "payment", paymentKind: "transfer", amountUsd: 1290, to: "0x4a1c00000000000000000000000000000000beef", agent: "payables" }, decision: { outcome: "deny", ruleId: "core-no-unknown-payee", reason: "" }, hash: hash(41) },
  { seq: 40, timestamp: iso(2400), request: { tool: "shell", command: "rm -rf ./data", agent: "research" }, decision: { outcome: "deny", ruleId: "deny-shell-destructive", reason: "" }, hash: hash(40) },
  { seq: 39, timestamp: iso(3900), event: { type: "payment", amountUsd: 184.2, by: me, txRef: tx(4) }, hash: hash(39) },
  { seq: 38, timestamp: iso(5400), event: { type: "shield-failed", agent: "payables", category: "utilities" }, hash: hash(38) },
  { seq: 37, timestamp: iso(6000), request: { tool: "http", url: "weather.gov/api/forecast", method: "GET", agent: "supplies" }, decision: { outcome: "allow", ruleId: "allow-listed-domain", reason: "" }, hash: hash(37) },
];

export const previewWallet: WalletInfo = { address: "0xe78f1b83b5f995a8c5fbc3b4ad1f3639fe6002ea", usdc: "18.42", gateway: "1.00" };
