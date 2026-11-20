// Live chain events for this console, from the relay (QuickNode Stream, or direct Arc RPC when
// QuickNode is quiet). Each Dharma event reaches every member's screen within seconds.
import { useEffect, useRef, useState } from "react";
import { demoChainSubscribe } from "./demo.ts";
import { PREVIEW } from "./preview.ts";

export interface ChainEvent {
  id: string;
  event: string;
  args: Record<string, unknown>;
  contract: string;
  txHash: string | null;
  block: number | null;
  source: "quicknode" | "rpc";
  receivedAt: string;
}

export type LiveMode = "quicknode" | "rpc" | "none" | "offline" | "connecting";

/** The demo's chain events, from its in-browser Gatekeeper (no relay, no chain). */
function useDemoRelay(onEvents: (events: ChainEvent[]) => void) {
  const [last, setLast] = useState<ChainEvent | null>(null);
  const cb = useRef(onEvents);
  cb.current = onEvents;
  useEffect(() => demoChainSubscribe((events) => {
    setLast(events[0]);
    cb.current(events);
  }), []);
  return { mode: "quicknode" as LiveMode, last };
}

export const useRelay = PREVIEW ? useDemoRelay : useLiveRelay;

function useLiveRelay(onEvents: (events: ChainEvent[]) => void) {
  const [mode, setMode] = useState<LiveMode>("connecting");
  const [last, setLast] = useState<ChainEvent | null>(null);
  const cb = useRef(onEvents);
  cb.current = onEvents;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/relay/ws`);
      ws.onopen = () => (retry = 0);
      ws.onmessage = (m) => {
        let msg: { type: string; mode?: LiveMode; events?: ChainEvent[]; recent?: ChainEvent[] };
        try {
          msg = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (msg.mode) setMode(msg.mode);
        if (msg.type === "hello" && msg.recent?.length) setLast(msg.recent[0]); // history: no pop-ups
        if (msg.type === "events" && msg.events?.length) {
          setLast(msg.events[0]);
          cb.current(msg.events);
        }
      };
      ws.onclose = () => {
        setMode("offline");
        if (!stopped) timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { mode, last };
}
