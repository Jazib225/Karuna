// Phase 1 demo: run a handful of proposals through the engine and the signed log.
// Mirrors the "gatekeeper terminal" panel on karunaprotocol.dev.
import { evaluate } from "./engine.ts";
import { bakeryContext } from "./rules.ts";
import { SignedLog } from "./log.ts";
import type { Request } from "./types.ts";

const ctx = bakeryContext({ spentTodayUsd: { supplies: 9.8 } });
const log = new SignedLog();

const proposals: Request[] = [
  { agent: "supplies", tool: "shell", command: "ls ./workspace" },
  { agent: "supplies", tool: "http", method: "GET", url: "https://api.stripe.com/v1/balance" },
  { agent: "supplies", tool: "payment", to: "0xGoldenMills", amountUsd: 0.05, category: "supplies" },
  { agent: "bills", tool: "payment", to: "0xGoldenMills", amountUsd: 900, category: "supplies" },
  { agent: "research", tool: "payment", to: "0xUNKNOWN", amountUsd: 50 },
  { agent: "research", tool: "shell", command: "cat .env" },
  { agent: "bills", tool: "shell", command: "rm -rf /" },
];

const mark = { allow: "allow  ", deny: "deny   ", approval: "approve" } as const;
console.log("  verdict  rule                       proposal");
console.log("  " + "-".repeat(70));
for (const p of proposals) {
  const d = evaluate(p, ctx);
  const e = log.append(p, d);
  const desc =
    p.tool === "payment" ? `pay $${p.amountUsd} -> ${p.to}` : p.command ?? `${p.method} ${p.url}`;
  console.log(`  ${mark[d.outcome]}  ${d.ruleId.padEnd(24)} ${p.agent}: ${desc}  [${e.hash.slice(0, 4)}…${e.hash.slice(-4)}]`);
}
console.log("  " + "-".repeat(70));
const v = log.verify();
console.log(`  Decision log signed. Chain head ${log.head().slice(0, 4)}…${log.head().slice(-4)} — verify: ${v.ok ? "OK" : "TAMPERED@" + v.brokenAt}`);
