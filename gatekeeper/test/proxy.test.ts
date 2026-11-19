// The egress proxy's tunnels, without a chain: a box's request can arrive as plain HTTP through
// CONNECT (Node's fetch does this for http:// URLs, e.g. the inbox at karuna.internal) or as TLS,
// on 443 or any other port. Each must reach the Gatekeeper's decision, never a dropped socket.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { EgressProxy, proxyListenHost } from "../src/proxy.ts";
import { SandboxCA } from "../src/ca.ts";
import type { Gatekeeper } from "../src/gatekeeper.ts";

const TOKEN = "ksess_test";
let ca: SandboxCA;
let proxy: EgressProxy;
let proxyPort: number;
let upstream: Server; // stands in for an allowed website
let agentApi: Server; // stands in for the Gatekeeper's agent API (inbox)
const seen: string[] = []; // every URL the Gatekeeper was asked about

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  ca = new SandboxCA(mkdtempSync(join(tmpdir(), "karuna-proxy-test-")));
  upstream = createServer((req, res) => res.end(`upstream ${req.method} ${req.url}`));
  agentApi = createServer((req, res) => res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization })));
  const apiPort = await listen(agentApi);
  await listen(upstream);
  // Only what the proxy calls. Hosts with "blocked" in the name are denied; the rest are allowed.
  const gk = Object.assign(new EventEmitter(), {
    session: (t: string) => (t === TOKEN ? { lastSeen: 0 } : null),
    egress: (_t: string, r: { url: string }) => {
      seen.push(r.url);
      return { verdict: new URL(r.url).hostname.includes("blocked") ? "deny" : "allow" };
    },
    revealKey: () => null,
    takeGrant: () => false,
    waitForDecision: async () => "denied",
    payForBox: async () => {
      throw new Error("not in this test");
    },
  }) as unknown as Gatekeeper;
  proxy = new EgressProxy(gk, ca, { agentApiPort: apiPort });
  proxyPort = await proxy.open(TOKEN);
});
afterAll(() => {
  proxy.close(TOKEN);
  upstream.close();
  agentApi.close();
});

/** Open a CONNECT tunnel through the proxy and return the raw socket once it's established. */
async function tunnel(target: string): Promise<Socket> {
  const s = netConnect(proxyPort, "127.0.0.1");
  await new Promise<void>((r) => s.once("connect", () => r()));
  s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const head = await new Promise<string>((r) => s.once("data", (d: Buffer) => r(d.toString())));
  expect(head).toMatch(/^HTTP\/1\.1 200/);
  return s;
}

/** Send one HTTP/1.1 request over a stream and read the whole answer. */
function exchange(sock: NodeJS.ReadWriteStream & { end(): void }, host: string, path = "/"): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    sock.on("data", (d: Buffer) => (out += d.toString()));
    sock.on("end", () => resolve(out));
    sock.on("close", () => resolve(out));
    sock.on("error", reject);
    sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });
}

describe("egress proxy: where each run's port listens", () => {
  const docker0 = { docker0: [{ address: "172.17.0.1", family: "IPv4" }] } as never;
  it("loopback with Docker Desktop (Windows, macOS) or no docker0 bridge", () => {
    expect(proxyListenHost({}, "win32", docker0)).toBe("127.0.0.1");
    expect(proxyListenHost({}, "darwin", docker0)).toBe("127.0.0.1");
    expect(proxyListenHost({}, "linux", {} as never)).toBe("127.0.0.1");
  });
  it("the docker0 bridge address on native Linux Docker, where boxes reach this machine", () => {
    expect(proxyListenHost({}, "linux", docker0)).toBe("172.17.0.1");
  });
  it("KARUNA_PROXY_HOST wins", () => {
    expect(proxyListenHost({ KARUNA_PROXY_HOST: "10.0.0.5" }, "linux", docker0)).toBe("10.0.0.5");
  });
});

describe("egress proxy: CONNECT tunnels", () => {
  it("plain HTTP through CONNECT to karuna.internal reaches the agent API (the inbox)", async () => {
    const s = await tunnel("karuna.internal:80");
    const res = await exchange(s, "karuna.internal", "/v1/inbox");
    expect(res).toMatch(/^HTTP\/1\.1 200/);
    expect(res).toContain('"path":"/v1/inbox"');
    expect(res).toContain(`Bearer ${TOKEN}`); // the proxy speaks for the box's session
  });

  it("plain HTTP through CONNECT to another host is decided by the Gatekeeper, then forwarded", async () => {
    const port = (upstream.address() as AddressInfo).port;
    const s = await tunnel(`127.0.0.1:${port}`);
    const res = await exchange(s, `127.0.0.1:${port}`, "/hello");
    expect(res).toMatch(/^HTTP\/1\.1 200/);
    expect(res).toContain("upstream GET /hello");
    expect(seen).toContain(`http://127.0.0.1:${port}/hello`);
  });

  it("TLS on 443 is terminated with the sandbox CA and decided (here: denied)", async () => {
    const s = await tunnel("blocked.example:443");
    const tls = tlsConnect({ socket: s, servername: "blocked.example", ca: ca.certPem });
    await new Promise<void>((r, j) => tls.once("secureConnect", () => r()).once("error", j));
    const res = await exchange(tls, "blocked.example");
    expect(res).toMatch(/^HTTP\/1\.1 403/);
    expect(res).toContain("Blocked by Karuna");
    expect(seen).toContain("https://blocked.example/");
  });

  it("TLS on another port is recognised from its first byte and terminated too", async () => {
    const s = await tunnel("blocked.example:8443");
    const tls = tlsConnect({ socket: s, servername: "blocked.example", ca: ca.certPem });
    await new Promise<void>((r, j) => tls.once("secureConnect", () => r()).once("error", j));
    const res = await exchange(tls, "blocked.example");
    expect(res).toMatch(/^HTTP\/1\.1 403/);
    expect(seen).toContain("https://blocked.example:8443/");
  });

  it("a tunnel for an unknown session is refused", async () => {
    const other = await proxy.open("ksess_other"); // a listener whose session the Gatekeeper doesn't know
    const s = netConnect(other, "127.0.0.1");
    await new Promise<void>((r) => s.once("connect", () => r()));
    s.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    const head = await new Promise<string>((r) => s.once("data", (d: Buffer) => r(d.toString())));
    expect(head).toMatch(/^HTTP\/1\.1 403/);
    s.destroy();
    proxy.close("ksess_other");
  });
});
