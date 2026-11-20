// The main window's first page: wait for the console, then open it. Dev builds use the console's
// dev server (:5173); the installed app starts its own services, console included, on :4173.
// A different address can be given as ?console=… on this page, or as VITE_KARUNA_CONSOLE_URL when
// the island's dev server starts (live mode serves the console's dev server on :4173, so the
// browser key saved for that address keeps working).
import { createContour } from "../../web/src/site/contour.ts";
import { mountGL } from "../../web/src/site/glrun.ts";

// Same theme as the console and island (remembered by the island: same origin as this page).
try {
  const pref = (JSON.parse(localStorage.getItem("karuna.appearance") ?? "{}") as { theme?: string }).theme;
  const dark = pref === "dark" || (pref !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
} catch {
  document.documentElement.dataset.theme = "dark";
}

const target =
  new URLSearchParams(location.search).get("console") ??
  (import.meta.env.VITE_KARUNA_CONSOLE_URL as string | undefined) ??
  (import.meta.env.DEV ? "http://127.0.0.1:5173" : "http://127.0.0.1:4173");
const dev = import.meta.env.DEV;

mountGL(document.getElementById("marble")!, (g) => createContour(g, "marble"), { fallbackSrc: "/brand/contour.webp", dprCap: 1.5 }).start();

const $ = (id: string) => document.getElementById(id)!;
$("cmds").textContent = dev
  ? "pnpm --dir gatekeeper start\npnpm --dir web dev"
  : "pnpm --dir gatekeeper start\npnpm --dir web build\npnpm --dir web preview";

type ServicesStatus = { managed: boolean; running?: boolean; code?: number | null; log?: string };
async function servicesStatus(): Promise<ServicesStatus | null> {
  const invoke = (window as unknown as { __TAURI__?: { core?: { invoke?: (cmd: string) => Promise<unknown> } } }).__TAURI__?.core?.invoke;
  try {
    return invoke ? ((await invoke("services_status")) as ServicesStatus) : null;
  } catch {
    return null;
  }
}

let tries = 0;
async function check() {
  tries++;
  try {
    // An opaque response is enough: it means something answers at the console's address.
    await fetch(target, { mode: "no-cors", cache: "no-store" });
    $("status").textContent = `Console found at ${target}`;
    location.replace(target);
    return;
  } catch {
    if (!dev) {
      // The installed app starts Karuna's services itself (src-tauri/src/services.rs): if they
      // stopped, say why at once, from the end of their log.
      if (tries > 2) $("title").textContent = "Starting Karuna…";
      const st = await servicesStatus();
      if (st?.managed && !st.running) {
        const lines = (st.log ?? "").split(/\r?\n/).filter(Boolean);
        const why = [...lines].reverse().find((l) => l.includes("can't start:"))?.split("can't start:")[1]?.trim();
        $("title").textContent = "Karuna couldn't start";
        $("help").hidden = false;
        $("help").querySelector("p")!.textContent = why
          ? `${why[0].toUpperCase()}${why.slice(1)}`
          : "Karuna's services stopped. The end of their log is below (all of it: %APPDATA%\\dev.karunaprotocol.desktop\\karuna.log). Quit Karuna from the tray and open it again.";
        if (!why) {
          $("cmds").textContent = lines.join("\n");
          $("cmds").hidden = false;
        }
        $("status").textContent = "";
        return;
      }
      if (tries > 40) $("status").textContent = "Still starting. The first start can take a minute.";
    } else if (tries > 2) {
      $("title").textContent = "Start the console";
      $("help").hidden = false;
      $("cmds").hidden = false;
      $("status").textContent = `Waiting for ${target} · retrying`;
    }
  }
  setTimeout(check, 1500);
}
void check();
