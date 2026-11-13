// Minimal stroke icons in the karunaprotocol.dev style.
import type { ReactNode } from "react";

const S = ({ children, size = 15 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);

export const I = {
  lotus: (p: { size?: number }) => (
    <svg width={p.size ?? 22} height={p.size ?? 22} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden>
      <path d="M16 7c2.6 2.8 3.4 6.5 2.2 10.4-.6 2-1.4 3.4-2.2 4.6-.8-1.2-1.6-2.6-2.2-4.6C12.6 13.5 13.4 9.8 16 7Z" />
      <path d="M15 21.6c-2.4-.4-4.9-1.8-6.4-4.4-.9-1.6-1.3-3.4-1.3-5.1 2.6.2 5.2 1.4 6.7 3.8" />
      <path d="M17 21.6c2.4-.4 4.9-1.8 6.4-4.4.9-1.6 1.3-3.4 1.3-5.1-2.6.2-5.2 1.4-6.7 3.8" />
      <path d="M14.4 22.4c-3 .6-6.6 0-9.4-2.4 1.6-1.2 3.7-1.8 5.7-1.6" />
      <path d="M17.6 22.4c3 .6 6.6 0 9.4-2.4-1.6-1.2-3.7-1.8-5.7-1.6" />
      <path d="M9 25h14" />
    </svg>
  ),
  receipt: () => <S><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6M9 16h3" /></S>,
  cart: () => <S><path d="M3 4h2l2.4 11h10.2L20 7H6.2" /><circle cx="9" cy="19" r="1.3" /><circle cx="17" cy="19" r="1.3" /></S>,
  search: () => <S><circle cx="11" cy="11" r="6" /><path d="m20 20-4.2-4.2" /></S>,
  lock: () => <S size={12}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></S>,
  check: () => <S size={11}><path d="m5 12 4.5 4.5L19 7" /></S>,
  x: () => <S size={11}><path d="M6 6l12 12M18 6 6 18" /></S>,
  clock: () => <S size={11}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2" /></S>,
  gate: () => <S><path d="M4 12h5M15 12h5" /><path d="M9 6v12M15 6v12" /></S>,
  doc: () => <S><path d="M7 3h7l4 4v14H7V3Z" /><path d="M14 3v4h4M10 12h5M10 16h5" /></S>,
  box: () => <S><rect x="5" y="5" width="14" height="14" rx="3" /><rect x="9" y="9" width="6" height="6" rx="1" /></S>,
  bolt: () => <S><path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z" /></S>,
  shield: () => <S><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></S>,
  ledger: () => <S><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 5v15" /></S>,
  no: () => <S size={10}><circle cx="12" cy="12" r="8" /><path d="m6.5 17.5 11-11" /></S>,
  freeze: () => <S size={13}><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" /></S>,
  arrow: () => <S size={12}><path d="M5 12h14M13 6l6 6-6 6" /></S>,
  pen: () => <S size={12}><path d="M4 20h4L19 9l-4-4L4 16v4Z" /></S>,
};

export const AgentIcon = ({ id }: { id: string }) =>
  id === "bills" ? <I.receipt /> : id === "supplies" ? <I.cart /> : <I.search />;

export const Glyph = ({ o }: { o: "allow" | "deny" | "approval" }) =>
  o === "allow" ? <I.check /> : o === "deny" ? <I.x /> : <I.clock />;
