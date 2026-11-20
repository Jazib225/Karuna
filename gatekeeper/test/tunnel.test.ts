// The console's public address: a quick tunnel started on request, its address handed to the
// Gatekeeper, and taken back when it stops. cloudflared is faked.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { Tunnel } from "../src/tunnel.ts";

function fakeCloudflared() {
  const procs: (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; kill: () => void; args: string[] })[] = [];
  const spawnFn = ((_bin: string, args: string[]) => {
    const p = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, args, kill: () => { p.exitCode = 1; p.emit("exit", 1); } });
    procs.push(p);
    return p;
  }) as never;
  return { procs, spawnFn };
}

describe("tunnel", () => {
  it("opens a quick tunnel to the public port and hands its address over", async () => {
    const f = fakeCloudflared();
    const seen: (string | null)[] = [];
    const t = new Tunnel("cloudflared", 8792, (u) => seen.push(u), null, f.spawnFn);
    const started = t.start();
    expect(t.status()).toMatchObject({ available: true, starting: true, running: false });
    expect(f.procs[0].args).toEqual(["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8792"]);
    f.procs[0].stderr.emit("data", Buffer.from("INF |  https://quiet-river-1234.trycloudflare.com  |"));
    expect(await started).toBe("https://quiet-river-1234.trycloudflare.com");
    expect(t.status()).toMatchObject({ running: true, starting: false, url: "https://quiet-river-1234.trycloudflare.com" });
    expect(await t.start()).toBe("https://quiet-river-1234.trycloudflare.com"); // no second tunnel
    expect(f.procs).toHaveLength(1);

    t.stop();
    expect(seen).toEqual(["https://quiet-river-1234.trycloudflare.com", null]);
    expect(t.status()).toMatchObject({ running: false, url: null, error: null });
  });

  it("says so when the tunnel drops, and when cloudflared exits before opening one", async () => {
    const f = fakeCloudflared();
    const seen: (string | null)[] = [];
    const t = new Tunnel("cloudflared", 8792, (u) => seen.push(u), null, f.spawnFn);
    const started = t.start();
    f.procs[0].stdout.emit("data", Buffer.from("https://a-b.trycloudflare.com"));
    await started;
    f.procs[0].emit("exit", 1);
    expect(seen).toEqual(["https://a-b.trycloudflare.com", null]);
    expect(t.status().error).toMatch(/closed/);

    const again = t.start();
    f.procs[1].emit("exit", 1);
    await expect(again).rejects.toThrow(/stopped/);
  });

  it("uses KARUNA_CHAT_URL as is, and explains a missing cloudflared", async () => {
    const ext = new Tunnel(null, 8792, () => {}, "https://karuna.example");
    expect(await ext.start()).toBe("https://karuna.example");
    expect(ext.status()).toMatchObject({ external: true, running: true });
    const none = new Tunnel(null, 8792, () => {});
    expect(none.status().available).toBe(false);
    await expect(none.start()).rejects.toThrow(/cloudflared isn't installed/);
  });
});
