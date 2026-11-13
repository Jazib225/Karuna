// Console ↔ Gatekeeper. Everything the console shows comes from the Gatekeeper; nothing is
// simulated or built in. Live updates arrive over server-sent events.
import { useCallback, useEffect, useRef, useState } from "react";

export type Outcome = "allow" | "deny" | "approval";
export type Status = "pending" | "executing" | "executed" | "allowed" | "denied" | "failed";

export interface Member { id: string; name: string; createdAt: string }
export interface Agent { id: string; name: string; dailyAllowanceUsd: number; createdAt: string; spentTodayUsd: number }
export interface Recipient { address: string; name: string; category: string; addedAt: string }
export interface Fact { label: string; value: string; tone?: "warn" | "ok" }

export interface Proposal {
  id: string;
  agentId: string;
  createdAt: string;
  action: { type: string; url?: string; method?: string; to?: string; amountUsd?: number; tool?: string; command?: string; path?: string };
  reason?: string;
  request: { tool: string; to?: string; amountUsd?: number; command?: string; url?: string; method?: string; path?: string; paymentKind?: string };
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

export interface Snapshot {
  setUp: boolean;
  org: {
    name: string;
    wallet: { address: string; chain: string } | null;
    members: Member[];
    agents: Agent[];
    recipients: Recipient[];
    allowlistedDomains: string[];
    twoPersonThresholdUsd: number;
  };
  frozen: { at: string; by: string } | null;
  unfreezeVotes: string[];
  unfreezeVotesNeeded: number;
  proposals: Proposal[];
  log: { length: number; head: string; verified: boolean; brokenAt: number | null; publicKeyPem: string };
}

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
    const es = new EventSource("/api/events");
    es.addEventListener("change", () => {
      refresh();
      refreshWallet();
    });
    es.onerror = () => setTimeout(refresh, 1500);
    const t = setInterval(refreshWallet, 20_000);
    return () => {
      es.close();
      clearInterval(t);
    };
  }, [refresh, refreshWallet]);

  return { state, log, wallet, offline, refresh, refreshWallet };
}
