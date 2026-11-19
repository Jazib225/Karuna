// A dropdown that looks like the rest of the console. The browser's own <select> list is drawn by the
// operating system (its fonts, its blue highlight) and can't be styled; this one uses the console's
// tokens in light and dark, and keeps what <select> does well: keyboard use and screen-reader roles.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./icons.tsx";

export interface PickerOption<V extends string> {
  value: V;
  label: string;
  hint?: string; // a quiet second line, e.g. where a key comes from
  group?: string; // options sharing a group are listed under its heading
}

export function Picker<V extends string>({ value, options, onChange, label, className = "", disabled = false }: {
  value: V;
  options: readonly PickerOption<V>[];
  onChange: (v: V) => void;
  label: string; // accessible name
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];
  const menu = useRef<HTMLUListElement>(null);

  // Keep the highlighted option in view in a long list.
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

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
    if (disabled || !options.length) return;
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
        aria-controls={listId} disabled={disabled} onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKey}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
      >
        <span className="picker-value">{current?.label ?? ""}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <ul className="picker-menu" role="listbox" id={listId} aria-label={label} ref={menu}>
          {options.map((o, i) => [
            o.group && o.group !== options[i - 1]?.group && <li key={`g-${o.group}`} role="presentation" className="picker-group">{o.group}</li>,
            <li
              key={o.value} id={`${listId}-${i}`} data-i={i} role="option" aria-selected={o.value === value}
              className={`picker-opt ${i === active ? "active" : ""} ${o.value === value ? "sel" : ""}`}
              onPointerEnter={() => setActive(i)} onPointerDown={(e) => e.preventDefault()}
              // preventDefault: inside a <label>, the click would otherwise also "click" the button and reopen the list
              onClick={(e) => { e.preventDefault(); choose(i); }}
            >
              <span className="picker-opt-text">
                <span className="picker-opt-label">{o.label}</span>
                {o.hint && <span className="picker-opt-hint">{o.hint}</span>}
              </span>
              {o.value === value && <Icon name="check" size={14} />}
            </li>,
          ])}
        </ul>
      )}
    </div>
  );
}

/** The console's dropdown in place of a <select>: string values, and a small pill size for rows of actions. */
export function Select({ value, options, onChange, label, small = false, disabled = false, className = "" }: {
  value: string;
  options: readonly PickerOption<string>[];
  onChange: (v: string) => void;
  label: string;
  small?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return <Picker value={value} options={options} onChange={onChange} label={label} disabled={disabled} className={`${small ? "picker-sm" : ""} ${className}`.trim()} />;
}
