// The Gatekeeper's remote port (S6): lets `karuna run` on another machine (a teammate's laptop, a
// cloud VM) box an agent under this org's Dharma rules. Off unless KARUNA_REMOTE_PORT is set.
//
// One TLS port, certificate signed by the org's sandbox CA (remote machines trust only that CA).
// What a connection is, is decided in the TLS handshake itself (ALPN), so no bytes are peeked:
//   - "karuna-tunnel/<session>": a run's egress tunnel, opened by that run's relay container and
//     served by the run's own proxy listener. The box is identified by its session, which only
//     the relay holds; the box never sends anything that could claim another identity;
//   - anything else ("http/1.1" or no ALPN): the agent API over HTTPS (start a run, heartbeat).
// Unknown or ended sessions fail the handshake; repeated failures from one address are throttled.
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import type { Server } from "node:http";
import type { SandboxCA } from "./ca.ts";
import type { EgressProxy } from "./proxy.ts";
import type { Gatekeeper } from "./gatekeeper.ts";

export const TUNNEL_ALPN = "karuna-tunnel/";

export function remoteListener(opts: { gk: Gatekeeper; ca: SandboxCA; names: string[]; proxy: EgressProxy; agentApi: Server }) {
  const failures = new Map<string, { n: number; at: number }>();
  const throttled = (ip: string) => {
    const f = failures.get(ip);
    return !!f && f.n >= 20 && Date.now() - f.at < 60_000;
  };
  const fail = (ip: string) => {
    const f = failures.get(ip);
    failures.set(ip, f && Date.now() - f.at < 60_000 ? { n: f.n + 1, at: f.at } : { n: 1, at: Date.now() });
  };

  const server = createTlsServer({
    ...opts.ca.serverCert(opts.names),
    ALPNCallback: ({ protocols }) => {
      const tunnel = protocols.find((p) => p.startsWith(TUNNEL_ALPN));
      if (tunnel) return opts.gk.session(tunnel.slice(TUNNEL_ALPN.length)) ? tunnel : undefined; // unknown run: handshake fails
      return protocols.includes("http/1.1") ? "http/1.1" : undefined;
    },
  }, (sock: TLSSocket) => {
    const ip = sock.remoteAddress ?? "?";
    sock.on("error", () => sock.destroy());
    const alpn = typeof sock.alpnProtocol === "string" ? sock.alpnProtocol : "";
    if (alpn.startsWith(TUNNEL_ALPN)) {
      if (!opts.proxy.attach(alpn.slice(TUNNEL_ALPN.length), sock)) {
        fail(ip);
        sock.destroy();
      }
      return;
    }
    opts.agentApi.emit("connection", sock);
  });
  server.on("tlsClientError", (_e, sock) => {
    const ip = sock.remoteAddress ?? "?";
    fail(ip);
    sock.destroy();
  });
  server.on("connection", (sock) => {
    if (throttled(sock.remoteAddress ?? "?")) sock.destroy();
  });
  return server;
}
