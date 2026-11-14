import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// The console talks to the Gatekeeper's console API through this proxy. The proxy adds the
// console secret server-side, so it never ships to the browser bundle and agents never see it.
// Bound to 127.0.0.1: anyone who can reach this server can approve payments.
const dataDir = resolve(process.env.KARUNA_DATA_DIR ?? resolve(__dirname, "../gatekeeper/data"));
const consoleToken = () => {
  try {
    return readFileSync(resolve(dataDir, "console.token"), "utf8").trim();
  } catch {
    return ""; // gatekeeper not started yet; it creates the token on first run
  }
};

const proxy: Record<string, ProxyOptions> = {
  // Live chain events (QuickNode Stream -> relay). Read-only, public chain data.
  "/relay": {
    target: `http://127.0.0.1:${process.env.RELAY_PORT ?? 8790}`,
    ws: true,
    changeOrigin: true,
  },
  "/api": {
    target: `http://127.0.0.1:${process.env.KARUNA_CONSOLE_PORT ?? 8788}`,
    changeOrigin: true,
    configure: (p) => {
      p.on("proxyReq", (req) => req.setHeader("x-karuna-console-token", consoleToken()));
    },
  },
};

// Sharing the console with a teammate through a tunnel (e.g. cloudflared → this server): requests
// that don't come from this machine must carry the share code, once in the link (?share=CODE), then
// as a cookie. Without it they get a 401, so a leaked or guessed tunnel URL can't use the console
// token. The code lives in the data dir (share.code), created on first use; delete it to revoke.
const shareCode = (() => {
  const f = resolve(dataDir, "share.code");
  try {
    return readFileSync(f, "utf8").trim();
  } catch {
    const code = randomBytes(18).toString("base64url");
    try {
      writeFileSync(f, code, { mode: 0o600 });
    } catch {
      /* data dir missing: sharing simply stays closed */
    }
    return code;
  }
})();
const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const shareGate = (): Plugin => {
  const gate = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    // A tunnel forwards to 127.0.0.1 but keeps its own Host: that's how outside requests are told apart.
    if (LOCAL.test(req.headers.host ?? "")) return next();
    const url = new URL(req.url ?? "/", "http://x");
    const cookie = /(?:^|;\s*)karuna_share=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (shareCode && url.searchParams.get("share") === shareCode) {
      res.setHeader("set-cookie", `karuna_share=${shareCode}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
      return next();
    }
    if (shareCode && cookie === shareCode) return next();
    res.statusCode = 401;
    res.setHeader("content-type", "text/plain");
    res.end("This Karuna console is private. Ask the person who runs it for the share link.");
  };
  return {
    name: "karuna-share-gate",
    configureServer: (s) => void s.middlewares.use(gate),
    configurePreviewServer: (s) => void s.middlewares.use(gate),
  };
};

export default defineConfig({
  plugins: [shareGate(), react()],
  server: {
    host: "127.0.0.1", port: Number(process.env.KARUNA_WEB_PORT ?? 5173), strictPort: true, proxy,
    // Quick tunnels (cloudflared) arrive with their own host name; the share gate above guards them.
    allowedHosts: [".trycloudflare.com"],
  },
  // The built console (`pnpm --dir web build && pnpm --dir web preview`): what the packaged desktop
  // app opens. Same proxy, same 127.0.0.1-only binding.
  preview: { host: "127.0.0.1", port: Number(process.env.KARUNA_WEB_PREVIEW_PORT ?? 4173), strictPort: true, proxy, allowedHosts: [".trycloudflare.com"] },
});
