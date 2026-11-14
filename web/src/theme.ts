// Appearance: Light, Dark, or System (follows the OS), for the console and, in the desktop app, the
// island and launch screen too. The choice is per browser (localStorage); the resolved theme is set
// on <html data-theme="light|dark">, which the stylesheet keys off.
import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "karuna.theme";
const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
const listeners = new Set<() => void>();

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export const resolveTheme = (pref: ThemePref): "light" | "dark" => (pref === "system" ? (media?.matches ? "dark" : "light") : pref);

function apply() {
  const theme = resolveTheme(getThemePref());
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  listeners.forEach((l) => l());
}

export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* per-browser convenience only */
  }
  apply();
}

/** Run `cb` whenever the theme choice or the OS theme changes. */
export function onThemeChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Set the theme before the first paint, and follow the OS while on System. */
export function startTheme() {
  apply();
  media?.addEventListener("change", () => getThemePref() === "system" && apply());
  window.addEventListener("storage", (e) => e.key === KEY && apply());
}

/** The current choice, re-rendering when it (or the OS theme) changes. */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getThemePref,
    () => "system",
  );
}
