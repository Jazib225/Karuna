// Console ↔ Gatekeeper. Everything the console shows comes from the Gatekeeper; nothing is
// simulated or built in. Live updates arrive over server-sent events.
import { useCallback, useEffect, useRef, useState } from "react";

export type Outcome = "allow" | "deny" | "approval";
export type Status = "pending" | "executing" | "executed" | "allowed" | "denied" | "failed";

export interface Fact { label: string; value: string; tone?: "warn" | "ok" }

export interface Proposal {
  id: string;
  agentId: string;
  createdAt: string;
  action: { type: string; url?: string; method?: string; to?: string; amountUsd?: number; tool?: string; command?: string; path?: string };
  reason?: string;
  request: { tool: string; to?: string; amountUsd?: number; command?: string; url?: string; method?: string; path?: string; paymentKind?: string; fileOp?: string };
  decision: { outcome: Outcome; ruleId: string; reason: string };
  facts: Fact[];
  payload?: { kind: "x402" | "transfer"; amountUsd: number };
  payloadHash?: string;
  status: Status;
  approvals: { memberId: string; at: string }[];
  approvalsNeeded: number;
  resolvedBy?: string;
  resolvedAt?: string;
  txRef?: string;
  error?: string;
}

export interface OnchainRule {
  id: string; outcome: Outcome; core: boolean; builtin: boolean; active: boolean;
  agent?: string; scope: string; target: string; maxUsd: number;
}

export interface Governance {
  id: number;
  op: number;
  description: string;
  proposer: string;
  createdAt: number;
  queuedAt: number;
  eta: number | null;
  core: boolean; // needs every member, waits the core wait, never skipped, cancelled by a freeze
  needed: number; // yes votes it needs
  yes: number;
  no: number;
  status: "none" | "open" | "queued" | "executed" | "defeated" | "cancelled";
  voters: string[];
  change: Record<string, unknown> & { op: string };
  preview: LooseningPreview | null;
}

/** Preview Before Loosening: the last 7 days of requests replayed under the proposed rules. */
export interface LooseningPreview {
  replayed: number;
  days: number;
  newlyAllowed: { proposalId: string; at: string; agent: string; to: string | null; amountUsd: number | null; was: string; now: string; flagged: string | null }[];
  newlyBlocked: number;
  flaggedAllowed: number;
}

export interface Learned {
  precedents: { id: string; at: string; agentId: string; agentName: string; counterparty: string; counterpartyName: string | null; amountUsd: number; bandLabel: string; outcome: "approve" | "deny"; byName: string }[];
  suggestions: { id: string; agentId: string; agentName: string; counterparty: string; counterpartyName: string | null; band: number; bandLabel: string; approvals: number; change: Record<string, unknown> & { op: string } }[];
  blocks: { id: string; agent: string | null; agentName: string | null; target: string; targetName: string | null }[];
  allows: { id: string; agent: string | null; agentName: string | null; target: string; targetName: string | null; maxUsd: number }[];
  suggestAfter: number;
}

export interface AgentView {
  id: string; name: string; capUsd: number; spentTodayUsd: number; active: boolean; hasToken: boolean;
  /** Trust level (Dharma v3); null on an older Dharma or for an agent not added yet. */
  level?: number | null;
  /** The agent's record, rebuilt by the relay from Dharma's events (QuickNode Stream). */
  record?: AgentRecord | null;
  eligibility?: { eligible: boolean; target: number | null; needed: number; have: number } | null;
}

export interface AgentRecord {
  agent: string; level: number; completed: number; denied: number; approvalsRequested: number; drillsFailed: number; tripwires: number;
  cleanStreak: number; levelChanges: { level: number; reason: string; block: number | null; txHash: string | null }[]; lastBlock: number | null;
}

export interface ConnectorView {
  name: string; url: string; hasKey: boolean; error: string | null;
  tools: { key: string; name: string; description: string; firstSeenAt: string; changed: { fingerprint: string; description: string; seenAt: string } | null }[];
}

export interface DeviceView {
  id: string; code: string; name: string; tool: string; status: "pending" | "approved";
  requestedAt: string; agentId: string | null; agentName: string | null; lastSeenAt: string | null; approvedAt: string | null;
}

export interface WatchdogEvent {
  key: string; at: string; txHash: string; to: string; amountUsd: number; block: number | null; source: string;
  verdict: "matched" | "gateway-deposit" | "unapproved"; proposalId?: string; txRef?: string;
}

export interface Snapshot {
  setUp: boolean;
  deploying: boolean;
  org: {
    name: string;
    wallet: { address: string; chain: string } | null;
    dharma: { address: string; chainId: number; deployedAt: string; txRef: string; explorer: string } | null;
  };
  policy: null | {
    loaded: true;
    chainTime: number;
    timelock: number; // normal wait, seconds
    coreTimelock: number; // core wait, seconds
    version: number;
    required: number;
    thresholdUsd: number;
    policyVersion: number;
    anchor: { head: string; length: number };
    members: { address: string; name: string | null }[];
    agents: AgentView[];
    payees: { account: string; category: string; name: string | null }[];
    domains: string[];
    rules: OnchainRule[];
    proposals: Governance[];
    /** Dharma v3: each level's payment limits (index = level), the grants, and the record's source. */
    levelLimits?: { perPaymentUsd: number; dailyUsd: number }[] | null;
    levelGrants?: { id: string; min: number; what: string }[];
    levelUpStreak?: number[];
    records?: { at: string; source: string } | null;
  };
  watchdog?: { wallet: string | null; gateway: string; events: WatchdogEvent[] };
  /** Computers running Claude Code or Cursor with the Karuna plugin, and connected chat apps. */
  devices?: DeviceView[];
  /** The team's connectors (MCP servers), reached only through Karuna. */
  connectors?: ConnectorView[];
  frozen: null | false | { by: string | null; at: string; confirmed: boolean };
  enrollments: { address: string; name: string; requestedAt: string }[];
  shield: {
    tests: ShieldTest[];
    alerts: ShieldAlert[];
    autoRules: { id: string; active: boolean; outcome: Outcome; agent: string | null; agentName: string | null; category: string; failedTest: string | null }[];
    templates: Record<string, string>;
    testsPerDay: number;
    windowMinutes: number;
  };
  learned: Learned;
  swarm: {
    traps: (TrapSet & { agentName: string | null; envFile: string })[];
    tainted: { agentId: string; agentName: string; at: string; secret: string }[];
    trips: { id: string; at: string; reason: string; agents: string[]; txRef?: string }[];
    agentsToTrip: number;
    windowSeconds: number;
  };
  inbox: (InboxMessage & { test: { id: string; status: ShieldTest["status"]; template: string } | null })[];
  proposals: Proposal[];
  log: { length: number; head: string; verified: boolean; brokenAt: number | null; publicKeyPem: string };
  sandbox: SandboxView;
}

/** Karuna sandboxes: live runs, the org's keys (names only, never values), and exemptions. */
export interface SandboxView {
  requireSandbox: boolean;
  remote: { port: number; host: string; names: string[] } | null;
  sessions: { id: string; agentId: string; agentName: string; startedAt: string; lastSeen: string; host: string | null; isolation: "gvisor" | "docker"; desktop: boolean; remote: boolean; viewer: string | null; requests: number; denied: number; lastRequest: string | null; stopRequested: boolean }[];
  keys: { name: string; envVar: string; placeholder: string; boundTo: string[]; createdAt: string; rotatedAt?: string; purpose?: "drafter"; provider?: "groq" | "gemini" }[];
  unsandboxed: string[];
}

export interface InboxMessage { id: string; agentId: string; from: string; subject: string; body: string; receivedAt: string; reportedAt?: string; reportReason?: string }
export interface ShieldTest {
  id: string; messageId: string; agentId: string; template: string; category: string;
  bait: { address: string; ref: string; amountUsd: number };
  sentAt: string; status: "pending" | "passed" | "failed"; resolvedAt?: string; resolution?: string; proposalIds: string[]; ruleId?: string;
}
export interface TrapSet { id: string; agentId: string | null; createdAt: string; secrets: { name: string; value: string }[] }
export interface ShieldAlert { id: string; kind: "shield-failed" | "shield-passed" | "changed-bank-account" | "agent-reported" | "trap-touched" | "swarm-stopped" | "watchdog" | "level-lowered"; agentId: string; title: string; body: string; at: string }

export interface LogEntry {
  seq: number;
  timestamp: string;
  request?: Proposal["request"] & { agent?: string };
  decision?: Proposal["decision"];
  event?: { type: string; [k: string]: unknown };
  hash: string;
}

export interface WalletInfo { address: string; usdc: string; gateway: string | null }
export interface Rule { id: string; description: string; outcome: Outcome }

export class ApiError extends Error {}

export async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Gatekeeper returned ${res.status}`);
  return data as T;
}

/** Live Gatekeeper state: refetches whenever the Gatekeeper reports a change. */
export function useGatekeeper() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  // One fetch at a time; a refresh asked for mid-flight runs again right after, so a change
  // made while a fetch was already running is never missed.
  const running = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const refresh = useCallback((): Promise<void> => {
    if (running.current) {
      again.current = true;
      return running.current;
    }
    const loop = async () => {
      do {
        again.current = false;
        try {
          const [s, l] = await Promise.all([api<Snapshot>("/state"), api<LogEntry[]>("/log?limit=300")]);
          setState(s);
          setLog(l);
          setOffline(null);
        } catch (e) {
          setOffline(e instanceof Error ? e.message : String(e));
        }
      } while (again.current);
      running.current = null;
    };
    running.current = loop();
    return running.current;
  }, []);

  const refreshWallet = useCallback(() => {
    api<WalletInfo | null>("/wallet").then(setWallet).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    refreshWallet();
    // Live updates. A browser gives up on an EventSource for good when a reconnect gets an error
    // response (e.g. the dev proxy's 502 while the Gatekeeper restarts), and the console would then
    // freeze on stale state (a panic freeze that never shows). So: reopen it ourselves with backoff,
    // re-read everything on every (re)connect, and poll slowly as a last resort.
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let backoff = 1000;
    let closed = false;
    let lastSeen = Date.now();
    const reopen = () => {
      es?.close();
      clearTimeout(retry);
      retry = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 15_000);
    };
    const open = () => {
      if (closed) return;
      lastSeen = Date.now();
      es = new EventSource("/api/events");
      const alive = () => (lastSeen = Date.now());
      es.addEventListener("hello", () => {
        alive();
        backoff = 1000;
        refresh();
        refreshWallet();
      });
      es.addEventListener("change", () => {
        alive();
        refresh();
        refreshWallet();
      });
      es.addEventListener("ping", alive);
      es.onerror = () => {
        refresh();
        if (es?.readyState === EventSource.CLOSED) reopen();
      };
    };
    open();
    // The Gatekeeper pings every 15 s. A proxy can keep a dead stream "open" with no error, so if
    // nothing arrives for 40 s, start over.
    const watchdog = setInterval(() => {
      if (Date.now() - lastSeen > 40_000) reopen();
    }, 10_000);
    const poll = setInterval(refresh, 15_000);
    const t = setInterval(refreshWallet, 20_000);
    return () => {
      closed = true;
      es?.close();
      clearTimeout(retry);
      clearInterval(watchdog);
      clearInterval(poll);
      clearInterval(t);
    };
  }, [refresh, refreshWallet]);

  return { state, log, wallet, offline, refresh, refreshWallet };
}
