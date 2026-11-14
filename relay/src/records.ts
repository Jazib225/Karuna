// Each agent's record (trust levels), rebuilt from Dharma's own events: the QuickNode Stream
// backfilled from the contract's deploy block, then live. Nothing here is self-reported by an
// agent; the counts come from what the Gatekeeper published onchain (ActionsRecorded, written
// with every log anchor) and from the events Dharma emits on its own (levels, Drills, Tripwires).
//
// Events can arrive twice (QuickNode and the RPC safety net) and out of order (a backfill racing
// live blocks), so the book keeps every relevant event once and recomputes from the sorted list.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentRecord } from "@prekaruna/dharma";
import type { DharmaEvent } from "./events.ts";

/** The events that make up a record. Everything else is ignored. */
export const RECORD_EVENTS = new Set(["AgentSet", "AgentRemoved", "ActionsRecorded", "ApprovalRequested", "TestFailed", "TripwireFired", "LevelSet"]);

type Stored = Pick<DharmaEvent, "id" | "event" | "args" | "block" | "logIndex" | "txHash" | "source">;

export class RecordBook {
  private events = new Map<string, Stored>();
  private dharma: string | null = null;

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as { dharma: string | null; events: Stored[] };
        this.dharma = saved.dharma;
        for (const e of saved.events) this.events.set(e.id, e);
      } catch {
        /* unreadable: rebuild from the Stream */
      }
    }
  }

  /** Switch organizations: a different Dharma starts an empty book. */
  useDharma(address: string | null) {
    const a = address?.toLowerCase() ?? null;
    if (a && a !== this.dharma) {
      this.dharma = a;
      this.events.clear();
      this.save();
    }
  }

  get size() {
    return this.events.size;
  }

  /** The highest block seen (where a catch-up read can resume). */
  lastBlock(): number | null {
    let max: number | null = null;
    for (const e of this.events.values()) if (e.block !== null && (max === null || e.block > max)) max = e.block;
    return max;
  }

  /** Add events (any source, any order). Returns true when the book changed. */
  add(events: DharmaEvent[]): boolean {
    let changed = false;
    for (const e of events) {
      if (!RECORD_EVENTS.has(e.event) || this.events.has(e.id)) continue;
      if (this.dharma && e.contract !== this.dharma) continue;
      this.events.set(e.id, { id: e.id, event: e.event, args: e.args, block: e.block, logIndex: e.logIndex, txHash: e.txHash, source: e.source });
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  /** Where the events came from: "quicknode" if the Stream delivered any of them. */
  source(): "quicknode" | "rpc" | "none" {
    if (!this.events.size) return "none";
    for (const e of this.events.values()) if (e.source === "quicknode") return "quicknode";
    return "rpc";
  }

  /** Every agent's record, from the events in chain order. */
  records(): Record<string, AgentRecord> {
    const sorted = [...this.events.values()].sort((a, b) => (a.block ?? 0) - (b.block ?? 0) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
    const out: Record<string, AgentRecord> = {};
    const base = new Map<string, number>(); // completed total at the agent's last level change or incident
    const get = (agent: string): AgentRecord =>
      (out[agent] ??= {
        agent, level: 0, completed: 0, denied: 0, approvalsRequested: 0, drillsFailed: 0, tripwires: 0, cleanStreak: 0, levelChanges: [], lastBlock: null,
      });
    for (const e of sorted) {
      const agent = typeof e.args.agent === "string" ? e.args.agent : null;
      if (!agent) continue;
      if (e.event === "AgentRemoved") {
        delete out[agent];
        base.delete(agent);
        continue;
      }
      const r = get(agent);
      r.lastBlock = e.block ?? r.lastBlock;
      switch (e.event) {
        case "ActionsRecorded":
          r.completed = Number(e.args.completed ?? r.completed);
          r.denied = Number(e.args.denied ?? r.denied);
          break;
        case "ApprovalRequested":
          r.approvalsRequested++;
          break;
        case "TestFailed":
          r.drillsFailed++;
          base.set(agent, r.completed);
          break;
        case "TripwireFired":
          r.tripwires++;
          base.set(agent, r.completed);
          break;
        case "LevelSet":
          r.level = Number(e.args.level ?? r.level);
          r.levelChanges.push({ level: r.level, reason: String(e.args.reason ?? ""), block: e.block, txHash: e.txHash });
          base.set(agent, r.completed);
          break;
      }
    }
    for (const r of Object.values(out)) r.cleanStreak = Math.max(0, r.completed - (base.get(r.agent) ?? 0));
    return out;
  }

  private save() {
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify({ dharma: this.dharma, events: [...this.events.values()] }));
    } catch {
      /* best effort: the Stream can rebuild it */
    }
  }
}
