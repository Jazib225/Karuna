// The main window's first page: wait for the console, then open it. Dev builds use the console's
// dev server (:5173); the packaged app uses the built console (`vite preview`, :4173).
// A different address can be given as ?console=… on this page.
import { createContour } from "../../web/src/site/contour.ts";
import { mountGL } from "../../web/src/site/glrun.ts";

const target = new URLSearchParams(location.search).get("console") ?? (import.meta.env.DEV ? "http://127.0.0.1:5173" : "http://127.0.0.1:4173");
const dev = target.includes(":5173");

mountGL(document.getElementById("marble")!, (g) => createContour(g, "marble"), { fallbackSrc: "/brand/contour.webp", dprCap: 1.5 }).start();

const $ = (id: string) => document.getElementById(id)!;
$("cmds").textContent = dev
  ? "pnpm --dir gatekeeper start\npnpm --dir web dev"
  : "pnpm --dir gatekeeper start\npnpm --dir web build\npnpm --dir web preview";

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
    if (tries > 2) {
      $("title").textContent = "Start the console";
      $("help").hidden = false;
      $("cmds").hidden = false;
      $("status").textContent = `Waiting for ${target} · retrying`;
    }
  }
  setTimeout(check, 1500);
}
void check();
