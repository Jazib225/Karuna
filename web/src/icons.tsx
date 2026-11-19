// Line icons in the karuna-site style: 24px grid, 1.5 stroke, round caps, currentColor.
import type { ReactNode, SVGProps } from "react";

const P = {
  home: "M3.5 10.5 12 4l8.5 6.5M5.5 9v10.5h13V9M10 19.5v-5h4v5",
  approvals: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3 2",
  votes: "M12 4v16M7 20h10M5 8h14M5 8l-2.5 6a3 3 0 0 0 5 0L5 8Zm14 0-2.5 6a3 3 0 0 0 5 0L19 8ZM12 4l-2 1.5M12 4l2 1.5",
  agents: "M8 8h8a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3ZM12 8V4.5M10 4.5h4M9.5 13v.5M14.5 13v.5M2.5 13v2M21.5 13v2",
  payees: "M4 8h14m0 0-3.5-3.5M18 8l-3.5 3.5M20 16H6m0 0 3.5-3.5M6 16l3.5 3.5",
  activity: "M3 12h4l2.5-6 5 12 2.5-6H21",
  shield: "M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6L12 3Zm-3 9 2 2 4-4",
  swarm: "M12 4.5 15 6.25v3.5L12 11.5 9 9.75v-3.5L12 4.5ZM7 12.5 10 14.25v3.5L7 19.5 4 17.75v-3.5L7 12.5ZM17 12.5l3 1.75v3.5l-3 1.75-3-1.75v-3.5l3-1.75Z",
  rules: "M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1M15 4.5v4M9 10v4M17 15.5v4",
  team: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.2a6.5 6.5 0 0 1 3.5 5.8",
  inbox: "M3.5 6.5h17v11h-17v-11Zm0 0L12 13l8.5-6.5",
  lock: "M6.5 10.5h11v9h-11v-9ZM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5",
  check: "m5 12.5 4.5 4.5L19 7.5",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5.5M12 7.5v.01",
  chevron: "m7 10 5 5 5-5",
  x: "M6 6l12 12M18 6 6 18",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3 2",
  alert: "M12 4 2.8 19.5h18.4L12 4ZM12 10v4M12 17v.01",
  external: "M7 17 17 7M9 7h8v8",
  arrow: "M5 12h14m0 0-5-5m5 5-5 5",
  copy: "M8.5 8.5h11v11h-11v-11ZM15.5 8.5v-4h-11v11h4",
  stop: "M8.3 3.5h7.4l5.3 5.3v7.4l-5.3 5.3H8.3L3 16.2V8.8l5.3-5.3ZM9 12h6",
  anchor: "M12 8a2.25 2.25 0 1 0 0-4.5A2.25 2.25 0 0 0 12 8Zm0 0v12.5M5 13a7 7 0 0 0 14 0M8.5 11h7",
  pen: "M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4",
  key: "M15 9.5a5 5 0 1 0-3.5 4.77L13 15.8h2.5v2.5H18V21h3v-3.2l-5.2-5.2A5 5 0 0 0 15 9.5ZM9.5 8h.01",
  menu: "M4 8h16M4 16h16",
  panel: "M4 5h16v14H4V5ZM9.5 5v14",
  pin: "M9.5 3.5h5l-1 6.5 3 3H7.5l3-3-1-6.5ZM12 13v7.5",
  wallet: "M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5v10A2.5 2.5 0 0 0 6.5 20H20V8H6.5A2.5 2.5 0 0 1 4 5.5M16 14h.01",
  signal: "M5 12.5a7 7 0 0 1 14 0M8.5 12.5a3.5 3.5 0 0 1 7 0M12 12.5v.01",
  plus: "M12 5v14M5 12h14",
  plug: "M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v5",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4",
  sparkle: "M12 3.5 13.8 10.2 20.5 12l-6.7 1.8L12 20.5l-1.8-6.7L3.5 12l6.7-1.8L12 3.5Z",
  logout: "M14 4.5H6.5v15H14M10 12h10.5m0 0-3.5-3.5m3.5 3.5-3.5 3.5",
  chain: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
} satisfies Record<string, string>;

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d={P[name]} />
    </svg>
  );
}

/** Verdict badge from karunaprotocol.dev: allow solid ink, approval dashed, deny grey. */
export type Verdict = "allow" | "approval" | "deny";
export function Badge({ v, children }: { v: Verdict; children?: ReactNode }) {
  return (
    <span className={`badge badge-${v}`}>
      <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        {v === "allow" ? <path d="M2.5 6.25 5 8.5l4.5-5" /> : v === "approval" ? <><circle cx="6" cy="6" r="4.25" /><path d="M6 3.75V6l1.5 1" /></> : <path d="M3 3l6 6M9 3 3 9" />}
      </svg>
      {children ?? (v === "approval" ? "Require approval" : v)}
    </span>
  );
}
