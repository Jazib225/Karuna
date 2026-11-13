// Engine demo: run sample proposals through the policy and the signed log.
// Uses a throwaway in-memory config — real organizations configure their own in the console.
import { evaluate } from "./engine.ts";
import { buildContext, DEFAULT_ALLOWLISTED_DOMAINS } from "./rules.ts";
import { SignedLog } from "./log.ts";
import type { Request } from "./types.ts";

const VENDOR = "0x1111111111111111111111111111111111111111";
const ctx = buildContext(
  {
    agents: [{ id: "agent-a", dailyAllowanceUsd: 10 }],
    recipients: [{ address: VENDOR, name: "Vendor A", category: "services" }],
    allowlistedDomains: DEFAULT_ALLOWLISTED_DOMAINS,
  },
  { "agent-a": 9.8 },
);
const log = new SignedLog();

const proposals: Request[] = [
  { agent: "agent-a", tool: "shell", command: "ls ./workspace" },
  { agent: "agent-a", tool: "http", method: "GET", url: "https://api.stripe.com/v1/balance" },
  { agent: "agent-a", tool: "payment", to: VENDOR, amountUsd: 0.05 },
  { agent: "agent-a", tool: "payment", to: VENDOR, amountUsd: 900 },
  { agent: "agent-a", tool: "payment", to: "0x2222222222222222222222222222222222222222", amountUsd: 50 },
  { agent: "agent-a", tool: "shell", command: "cat .env" },
  { agent: "agent-a", tool: "shell", command: "rm -rf /" },
];

const mark = { allow: "allow  ", deny: "deny   ", approval: "approve" } as const;
console.log("  verdict  rule                       proposal");
console.log("  " + "-".repeat(70));
for (const p of proposals) {
  const d = evaluate(p, ctx);
  const e = log.append(p, d);
  const desc =
    p.tool === "payment" ? `pay $${p.amountUsd} -> ${p.to!.slice(0, 8)}…` : (p.command ?? `${p.method} ${p.url}`);
  console.log(`  ${mark[d.outcome]}  ${d.ruleId.padEnd(24)} ${desc}  [${e.hash.slice(0, 4)}…${e.hash.slice(-4)}]`);
}
console.log("  " + "-".repeat(70));
const v = log.verify();
console.log(
  `  Decision log signed. Chain head ${log.head().slice(0, 4)}…${log.head().slice(-4)} — verify: ${v.ok ? "OK" : "TAMPERED@" + v.brokenAt}`,
);
