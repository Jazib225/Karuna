import { defineConfig } from "vite";
import { resolve } from "node:path";

// The island's front end. It imports the site visuals from ../web/src/site (one copy, shared with
// the console), and the console's public assets (contour.webp, lotus-dither.webp).
export default defineConfig({
  clearScreen: false,
  publicDir: resolve(__dirname, "../web/public"),
  server: { host: "127.0.0.1", port: 1420, strictPort: true, fs: { allow: [resolve(__dirname, "..")] } },
  build: { outDir: "dist", emptyOutDir: true, rollupOptions: { input: { island: resolve(__dirname, "island.html"), launch: resolve(__dirname, "launch.html") } } },
});
