import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
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

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.KARUNA_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      // Live chain events (QuickNode Stream -> relay). Read-only, public chain data.
      "/relay": {
        target: `http://127.0.0.1:${process.env.RELAY_PORT ?? 8790}`,
        ws: true,
        changeOrigin: true,
      },
      "/api": {
        target: `http://127.0.0.1:${process.env.KARUNA_CONSOLE_PORT ?? 8788}`,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => req.setHeader("x-karuna-console-token", consoleToken()));
        },
      },
    },
  },
});
