// Which bottom-right pop-ups a Dharma proposal makes. One proposal is many chain events (created,
// a vote, passed, in effect), and showing each one stacked three cards per proposal. Here:
//
//   your proposal, in effect at once (no wait)  → one card: "In effect"
//   your proposal with a wait (votes or timer)  → "Proposed" now, "Now active" when it applies
//   a teammate's proposal                        → one "Vote" card (it stays until you've voted)
//   defeated                                     → one card
//
// Votes and "passed" never pop up (the Votes page shows them). Your own proposals wait a moment
// before showing, so one that applies straight away shows only "In effect", and several made at
// once (a new agent's rules, say) share one card.

export type GovKind = "created" | "vote" | "queued" | "executed" | "defeated";

export interface GovEvent {
  kind: GovKind;
  id: number;
  /** Proposed or voted by this member. */
  mine: boolean;
  /** What the proposal does, in words ("Add rule …"). */
  what: string;
  /** For "created": who proposed it (a name). */
  by?: string;
}

export interface ProposalToast {
  key: string;
  title: string;
  body: string;
  tone: "ok" | "info";
  /** Teammates' proposals stay until you've voted on them. */
  sticky: boolean;
  /** Go to Votes. */
  vote?: boolean;
  /** The proposal a sticky "Vote" card is about. */
  proposalId?: number;
}

/** Quiet time after the last event before a card shows, so changes made together share one card. */
export const GROUP_MS = 1500;
/** When every member's yes is already in (a one-member org), Karuna applies a proposal right away:
 *  wait up to this long for it to apply before saying "Proposed". */
export const INSTANT_MAX_MS = 20_000;

interface Held { id: number; what: string; at: number; applied: boolean }

export class ProposalToaster {
  private proposed: Held[] = [];
  private applied: Held[] = [];
  private seq = 0;

  /** Feed one chain event; returns any card to show now (teammates' proposals, defeats). */
  push(e: GovEvent, now: number): ProposalToast[] {
    switch (e.kind) {
      case "created":
        if (e.mine) {
          this.proposed.push({ id: e.id, what: e.what, at: now, applied: false });
          return [];
        }
        return [{ key: `vote-${e.id}`, tone: "info", sticky: true, vote: true, proposalId: e.id, title: `New proposal #${e.id}`, body: `${e.by ?? "A member"}: ${e.what}` }];
      case "executed": {
        const held = this.proposed.find((h) => h.id === e.id);
        if (held) {
          held.applied = true; // applied before we showed "Proposed": only "Now active"
          held.at = now;
        }
        else if (!this.applied.some((h) => h.id === e.id)) this.applied.push({ id: e.id, what: e.what, at: now, applied: true });
        return [];
      }
      case "defeated":
        this.proposed = this.proposed.filter((h) => h.id !== e.id);
        return [{ key: `defeated-${e.id}-${++this.seq}`, tone: "info", sticky: false, title: `Proposal #${e.id} defeated`, body: e.what }];
      default:
        return []; // votes and "passed": the Votes page shows them
    }
  }

  /** Cards whose wait is over (call about once a second). */
  flush(now: number, wait: Wait): ProposalToast[] {
    const out: ProposalToast[] = [];

    const quiet = (list: Held[]) => list.length > 0 && now - Math.max(...list.map((h) => h.at)) >= GROUP_MS;
    const proposedDue = quiet(this.proposed) && (!wait.instant || this.proposed.every((h) => h.applied) || now - Math.min(...this.proposed.map((h) => h.at)) >= INSTANT_MAX_MS);
    if (proposedDue) {
      const instant = this.proposed.filter((h) => h.applied);
      const waiting = this.proposed.filter((h) => !h.applied);
      this.proposed = [];
      // Applied at once: grouped with any other changes that applied in the same moment.
      this.applied.push(...instant);
      if (waiting.length) out.push(proposedCard(waiting, wait, ++this.seq));
    }
    if (quiet(this.applied)) {
      out.push(activeCard(this.applied, ++this.seq));
      this.applied = [];
    }
    return out;
  }
}

export interface Wait {
  required: number;
  timelock: number;
  /** Your yes is the only one needed (one member), so Karuna applies proposals right away. */
  instant: boolean;
}

function proposedCard(list: Held[], wait: Wait, seq: number): ProposalToast {
  const more = Math.max(0, wait.required - 1);
  const when = more > 0 ? `Needs ${more} more vote${more > 1 ? "s" : ""}, then ${secs(wait.timelock)}` : `Becomes active in ${secs(wait.timelock)}`;
  return list.length === 1
    ? { key: `proposed-${seq}`, tone: "ok", sticky: false, title: `Proposed #${list[0].id}`, body: `${list[0].what}. ${when}.` }
    : { key: `proposed-${seq}`, tone: "ok", sticky: false, title: `Proposed ${list.length} changes`, body: `${list.map((h) => `#${h.id}`).join(", ")}. ${when}.` };
}

function activeCard(list: Held[], seq: number): ProposalToast {
  return list.length === 1
    ? { key: `active-${seq}`, tone: "ok", sticky: false, title: `Now active: #${list[0].id}`, body: list[0].what }
    : { key: `active-${seq}`, tone: "ok", sticky: false, title: `${list.length} changes now active`, body: list.map((h) => `#${h.id}`).join(", ") };
}

function secs(s: number) {
  if (s <= 0) return "a moment";
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}
