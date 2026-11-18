// A dropdown that looks like the rest of the console. The browser's own <select> list is drawn by the
// operating system (its fonts, its blue highlight) and can't be styled; this one uses the console's
// tokens in light and dark, and keeps what <select> does well: keyboard use and screen-reader roles.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./icons.tsx";

export interface PickerOption<V extends string> {
  value: V;
  label: string;
  hint?: string; // a quiet second line, e.g. where a key comes from
}

export function Picker<V extends string>({ value, options, onChange, label, className = "" }: {
  value: V;
  options: readonly PickerOption<V>[];
  onChange: (v: V) => void;
  label: string; // accessible name
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];

  // Close on a click or focus anywhere else.
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("focusin", away);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("focusin", away);
    };
  }, [open]);

  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const choose = (i: number) => {
    onChange(options[i].value);
    setOpen(false);
    button.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const last = options.length - 1;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(last, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(last);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={`picker ${open ? "open" : ""} ${className}`} ref={root}>
      <button
        type="button" ref={button} className="picker-btn" aria-label={label} aria-haspopup="listbox" aria-expanded={open}
        aria-controls={listId} onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKey}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
      >
        <span className="picker-value">{current.label}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <ul className="picker-menu" role="listbox" id={listId} aria-label={label}>
          {options.map((o, i) => (
            <li
              key={o.value} id={`${listId}-${i}`} role="option" aria-selected={o.value === value}
              className={`picker-opt ${i === active ? "active" : ""} ${o.value === value ? "sel" : ""}`}
              onPointerEnter={() => setActive(i)} onPointerDown={(e) => e.preventDefault()} onClick={() => choose(i)}
            >
              <span className="picker-opt-text">
                <span className="picker-opt-label">{o.label}</span>
                {o.hint && <span className="picker-opt-hint">{o.hint}</span>}
              </span>
              {o.value === value && <Icon name="check" size={14} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
