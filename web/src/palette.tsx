// Ctrl+K / Cmd+K command palette: jump to any page or run a common action from the keyboard.
// Type to filter, ↑ ↓ to move, Enter to run, Esc to close.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./icons.tsx";

export interface Command {
  id: string;
  label: string;
  hint?: string; // right-hand text: a section name or a shortcut
  icon: IconName;
  keywords?: string; // extra words that should match
  run: () => void;
}

/** Score how well `q` matches: every typed word must appear; earlier and word-start matches rank higher. */
function score(c: Command, q: string): number {
  const hay = `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase();
  let total = 0;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const i = hay.indexOf(w);
    if (i < 0) return -1;
    total += i === 0 ? 0 : /\s/.test(hay[i - 1]) ? 1 : 3;
  }
  return total;
}

export function Palette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    if (!q.trim()) return commands;
    return commands
      .map((c, i) => ({ c, s: score(c, q), i }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map((x) => x.c);
  }, [commands, q]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    input.current?.focus(); // the input exists once open is true
  }, [open]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;
  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((i) => (shown.length ? (i + 1) % shown.length : 0));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((i) => (shown.length ? (i - 1 + shown.length) % shown.length : 0));
              } else if (e.key === "Home") {
                e.preventDefault();
                setSel(0);
              } else if (e.key === "End") {
                e.preventDefault();
                setSel(Math.max(0, shown.length - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(shown[sel]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
        }}>
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={input}
            autoFocus
            value={q}
            placeholder="Go to a page or run an action…"
            aria-label="Search commands"
            aria-controls="palette-list"
            aria-activedescendant={shown[sel] ? `cmd-${shown[sel].id}` : undefined}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {shown.length === 0 && <div className="palette-empty">Nothing matches “{q}”.</div>}
          {shown.map((c, i) => (
            <div
              key={c.id}
              id={`cmd-${c.id}`}
              data-i={i}
              role="option"
              aria-selected={i === sel}
              className={`palette-item ${i === sel ? "sel" : ""}`}
              onMouseMove={() => i !== sel && setSel(i)}
              onClick={() => run(c)}
            >
              <Icon name={c.icon} size={16} />
              <span className="palette-label">{c.label}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
            </div>
          ))}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl</kbd><kbd>K</kbd> toggle</span></div>
      </div>
    </div>
  );
}
