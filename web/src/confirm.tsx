// Karuna's own confirm dialog, in place of the browser's confirm() box ("127.0.0.1:4173 says").
// Call askConfirm() from anywhere; <ConfirmHost /> (mounted once, in main.tsx) draws it.
//
//   if (await askConfirm("Delete key x? Boxes using it start failing at once.", { action: "Delete", danger: true })) …
//
// Esc or a click outside cancels. Only a real click (or Enter on the focused button) confirms.
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons.tsx";

export interface ConfirmOptions {
  /** The confirm button's label, saying what it does: "Remove", "Delete", "Freeze all"… */
  action?: string;
  /** A destructive or risky step: the button is red and the dialog shows a warning mark. */
  danger?: boolean;
  icon?: IconName;
}

interface Ask extends ConfirmOptions {
  id: number;
  message: string;
  resolve: (ok: boolean) => void;
}

let current: Ask | null = null;
let nextId = 1;
const listeners = new Set<(a: Ask | null) => void>();
const publish = () => listeners.forEach((l) => l(current));

/** Ask the person to confirm; resolves true on confirm, false on cancel. One dialog at a time. */
export function askConfirm(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  current?.resolve(false); // a newer question replaces an unanswered one
  return new Promise((resolve) => {
    current = { id: nextId++, message, resolve, ...opts };
    publish();
  });
}

const LEAVE_MS = 160;

export function ConfirmHost() {
  const [ask, setAsk] = useState<Ask | null>(current);
  const [leaving, setLeaving] = useState(false);
  const okRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    const l = (a: Ask | null) => {
      if (a) {
        returnFocus.current = document.activeElement;
        setLeaving(false);
      }
      setAsk(a);
    };
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);

  const close = (ok: boolean) => {
    if (!ask || leaving) return;
    const a = ask;
    setLeaving(true);
    window.setTimeout(() => {
      if (current?.id === a.id) current = null;
      a.resolve(ok);
      setAsk((x) => (x?.id === a.id ? null : x));
      setLeaving(false);
      (returnFocus.current as HTMLElement | null)?.focus?.();
    }, LEAVE_MS);
  };

  useEffect(() => {
    if (!ask) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!ask) return null;
  const [lead, ...rest] = ask.message.split("\n\n");
  return (
    <div className={`confirm-backdrop${leaving ? " leaving" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className={`confirm-dialog${ask.danger ? " danger" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby={`confirm-msg-${ask.id}`}>
        <span className="confirm-mark" aria-hidden><Icon name={ask.icon ?? (ask.danger ? "alert" : "check")} size={18} /></span>
        <div className="confirm-body">
          <p className="confirm-lead" id={`confirm-msg-${ask.id}`}>{lead}</p>
          {rest.length > 0 && <div className="confirm-detail">{rest.join("\n\n")}</div>}
        </div>
        <div className="confirm-actions">
          <button type="button" className="btn btn-ghost" onClick={() => close(false)}>Cancel</button>
          <button type="button" ref={okRef} className={`btn ${ask.danger ? "btn-danger" : "btn-dark"}`} onClick={() => close(true)}>{ask.action ?? "OK"}</button>
        </div>
      </div>
    </div>
  );
}
