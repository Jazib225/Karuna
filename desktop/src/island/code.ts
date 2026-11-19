// The spoken code: how a loosening said out loud stays a member's own decision.
//
// A loosening voice tool (approve, vote yes, resume, propose) never acts. It asks for a code: a
// random three-digit number shown only on the island's screen. The voice model is never told the
// code, so it can't say it, and text an agent wrote can't contain it. Only a USER transcript (the
// member's own speech, as the speech recognizer heard it) that says the action's word and the code
// within the time limit confirms it, once, for that one request.
//
// No dependencies and no DOM: tested on its own (code.test.ts).

export type CodeAction = "approve" | "vote_yes" | "resume_all" | "propose_draft";

/** The word the member says before the digits, per action. */
export const CODE_VERB: Record<CodeAction, string> = { approve: "approve", vote_yes: "yes", resume_all: "resume", propose_draft: "propose" };

export interface PendingCode {
  code: string; // three digits, e.g. "472"
  action: CodeAction;
  target: string; // the request id, vote id, draft id ("" for resume_all)
  hash: string | null; // the request's payload hash at the time (approve only)
  expiresAt: number;
  /** What the member should say: "approve 4 7 2". */
  phrase: string;
}

export const CODE_TTL_MS = 30_000;

const WORD_DIGITS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", one: "1", won: "1", two: "2", to: "2", too: "2", three: "3", four: "4", for: "4", five: "5",
  six: "6", seven: "7", eight: "8", ate: "8", nine: "9",
};

/** "Approve, four-seven two!" -> ["approve", "4", "7", "2"]; "472" -> "4","7","2". */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")) {
    if (!raw) continue;
    if (/^\d+$/.test(raw)) out.push(...raw.split(""));
    else out.push(WORD_DIGITS[raw] ?? raw);
  }
  return out;
}

export interface CodeOptions {
  now?: () => number;
  random?: () => number;
  ttlMs?: number;
}

export class SpokenCodes {
  private readonly pending = new Map<string, PendingCode>(); // by code
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly ttlMs: number;

  constructor(opts: CodeOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? (() => {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return a[0] / 2 ** 32;
    });
    this.ttlMs = opts.ttlMs ?? CODE_TTL_MS;
  }

  /** A new code for one action on one target. Any earlier code for the same action and target is dropped. */
  issue(action: CodeAction, target: string, hash: string | null = null): PendingCode {
    this.sweep();
    for (const [c, p] of this.pending) if (p.action === action && p.target === target) this.pending.delete(c);
    let code = "";
    for (let tries = 0; tries < 50; tries++) {
      code = String(Math.floor(this.random() * 900) + 100); // 100-999: no leading zero to mishear
      if (!this.pending.has(code)) break;
    }
    const p: PendingCode = { code, action, target, hash, expiresAt: this.now() + this.ttlMs, phrase: `${CODE_VERB[action]} ${code.split("").join(" ")}` };
    this.pending.set(code, p);
    return p;
  }

  /**
   * One final transcript of the MEMBER's speech. Returns the code it confirms (and uses it up), or
   * null. Never call this with the voice model's replies or anything an agent wrote.
   */
  confirm(userTranscript: string): PendingCode | null {
    this.sweep();
    const t = tokens(userTranscript);
    for (const p of this.pending.values()) {
      const verb = CODE_VERB[p.action];
      const d = p.code.split("");
      for (let i = 0; i + 3 < t.length; i++) {
        // the action's word, then the three digits right after it (optionally "code"/"is" between)
        if (t[i] !== verb) continue;
        let j = i + 1;
        while (j < t.length && (t[j] === "code" || t[j] === "is" || t[j] === "the")) j++;
        if (t[j] === d[0] && t[j + 1] === d[1] && t[j + 2] === d[2]) {
          this.pending.delete(p.code);
          return p;
        }
      }
    }
    return null;
  }

  /** Drop a code without using it (the request was answered elsewhere, or the panel closed). */
  cancel(action: CodeAction, target: string) {
    for (const [c, p] of this.pending) if (p.action === action && p.target === target) this.pending.delete(c);
  }

  clear() {
    this.pending.clear();
  }

  list(): PendingCode[] {
    this.sweep();
    return [...this.pending.values()];
  }

  private sweep() {
    const now = this.now();
    for (const [c, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(c);
  }
}
