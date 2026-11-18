import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseUndoArgs } from "../src/args.ts";
import {
  listChanges, pruneSnapshots, readManifest, recordChanges, renameSnapshot, takeSnapshot, toReport, undoRun, unifiedDiff,
} from "../src/snapshot.ts";

const temp = (p: string) => mkdtempSync(join(tmpdir(), p));
const BIN = Buffer.from([0, 1, 2, 3, 255, 0, 10, 13]);

/** A mount with a text file, a binary file and a nested file; a fresh snapshot root. */
function setup() {
  const mount = temp("karuna-mount-");
  const root = temp("karuna-snaps-");
  writeFileSync(join(mount, "notes.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(mount, "logo.bin"), BIN);
  mkdirSync(join(mount, "sub"));
  writeFileSync(join(mount, "sub", "gone.txt"), "bye\n");
  writeFileSync(join(mount, "keep.txt"), "same\n");
  return { mount: resolve(mount), root };
}

/** What an agent might do: edit, add (in a new folder), delete, change a binary. */
function agentEdits(mount: string) {
  writeFileSync(join(mount, "notes.txt"), "one\nTWO\nthree\n");
  mkdirSync(join(mount, "out", "deep"), { recursive: true });
  writeFileSync(join(mount, "out", "deep", "report.md"), "# Report\n");
  writeFileSync(join(mount, "logo.bin"), Buffer.from([9, 0, 9]));
  unlinkSync(join(mount, "sub", "gone.txt"));
}

describe("snapshot and changes", () => {
  it("lists exactly what was added, modified and deleted, with diffs for text", () => {
    const { mount, root } = setup();
    takeSnapshot("run1", [mount], { root });
    agentEdits(mount);
    const changes = toReport(recordChanges("run1", { root }));
    expect(changes.map((c) => [c.path, c.kind, c.binary])).toEqual([
      ["logo.bin", "modified", true],
      ["notes.txt", "modified", false],
      ["out/deep/report.md", "added", false],
      ["sub/gone.txt", "deleted", false],
    ]);
    expect(changes.every((c) => c.mount === mount)).toBe(true);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    expect(byPath["notes.txt"].diff).toBe("--- a/notes.txt\n+++ b/notes.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n");
    expect(byPath["out/deep/report.md"].diff).toBe("--- /dev/null\n+++ b/out/deep/report.md\n@@ -0,0 +1,1 @@\n+# Report\n");
    expect(byPath["sub/gone.txt"].diff).toBe("--- a/sub/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n");
    expect(byPath["logo.bin"].diff).toBeNull();

    const listed = listChanges("run1", { root });
    expect(listed.finishedAt).not.toBeNull();
    expect(listed.changes.map((c) => c.state)).toEqual(["as-run", "as-run", "as-run", "as-run"]);
  });

  it("skips big files, node_modules and .git and records them", () => {
    const { mount, root } = setup();
    writeFileSync(join(mount, "big.dat"), Buffer.alloc(5000, 1));
    mkdirSync(join(mount, "node_modules", "x"), { recursive: true });
    writeFileSync(join(mount, "node_modules", "x", "index.js"), "a");
    mkdirSync(join(mount, ".git"));
    writeFileSync(join(mount, ".git", "HEAD"), "ref");
    const m = takeSnapshot("run2", [mount], { root, maxFileBytes: 4096 });
    expect(m.mounts[0].skipped.map((s) => s.path).sort()).toEqual([".git", "big.dat", "node_modules"]);
    expect(m.mounts[0].skipped.find((s) => s.path === "big.dat")!.reason).toMatch(/^over /);
    expect(Object.keys(m.mounts[0].files).sort()).toEqual(["keep.txt", "logo.bin", "notes.txt", "sub/gone.txt"]);
    expect(existsSync(join(root, "run2", "files", "0", "node_modules"))).toBe(false);
    // Changes inside skipped paths are not reported (they can't be undone).
    writeFileSync(join(mount, "big.dat"), Buffer.alloc(6000, 2));
    writeFileSync(join(mount, "node_modules", "x", "index.js"), "b");
    writeFileSync(join(mount, ".git", "HEAD"), "other");
    expect(recordChanges("run2", { root })).toEqual([]);
    expect(listChanges("run2", { root }).skipped.map((s) => s.path).sort()).toEqual([".git", "big.dat", "node_modules"]);
  });

  it("formats files without a trailing newline", () => {
    expect(unifiedDiff("a\nb", "a\nc", "f")).toBe("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n");
    expect(unifiedDiff("same\n", "same\n", "f")).toBe("");
  });

  it("keeps the context to 3 lines and splits distant hunks", () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const next = old.replace("l2\n", "L2\n").replace("l18\n", "L18\n");
    const d = unifiedDiff(old, next, "f");
    expect(d.match(/^@@.*@@$/gm)).toEqual(["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"]);
  });

  it("renames a pending snapshot to its run id", () => {
    const { mount, root } = setup();
    takeSnapshot("pending-abc", [mount], { root });
    renameSnapshot("pending-abc", "run-final", { root });
    expect(readManifest("run-final", { root }).runId).toBe("run-final");
    expect(existsSync(join(root, "pending-abc"))).toBe(false);
  });
});

describe("undo", () => {
  it("restores a whole run byte for byte and removes what it added", () => {
    const { mount, root } = setup();
    const before = Object.fromEntries(["notes.txt", "logo.bin", "sub/gone.txt", "keep.txt"].map((p) => [p, readFileSync(join(mount, p))]));
    takeSnapshot("run3", [mount], { root });
    agentEdits(mount);
    recordChanges("run3", { root });
    const r = undoRun("run3", { root });
    expect(r.refused).toBe(false);
    expect(r.restored.map((x) => x.path).sort()).toEqual(["logo.bin", "notes.txt", "out/deep/report.md", "sub/gone.txt"]);
    expect(r.skipped).toEqual([]);
    for (const [p, buf] of Object.entries(before)) expect(readFileSync(join(mount, p)).equals(buf)).toBe(true);
    expect(existsSync(join(mount, "out"))).toBe(false); // the folders it created are gone too
    expect(readdirSync(mount).sort()).toEqual(["keep.txt", "logo.bin", "notes.txt", "sub"]);
    expect(listChanges("run3", { root }).changes.every((c) => c.state === "undone")).toBe(true);
    // A second undo has nothing left to do.
    const again = undoRun("run3", { root });
    expect(again.restored).toEqual([]);
    expect(again.skipped.every((s) => s.reason === "already undone")).toBe(true);
  });

  it("undoes one file only", () => {
    const { mount, root } = setup();
    takeSnapshot("run4", [mount], { root });
    agentEdits(mount);
    recordChanges("run4", { root });
    const r = undoRun("run4", { root, path: join(mount, "notes.txt") });
    expect(r.restored).toEqual([{ mount, path: "notes.txt", kind: "modified" }]);
    expect(readFileSync(join(mount, "notes.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(existsSync(join(mount, "out", "deep", "report.md"))).toBe(true);
    expect(existsSync(join(mount, "sub", "gone.txt"))).toBe(false);
    // Restoring a deleted file, by its path.
    expect(undoRun("run4", { root, path: join(mount, "sub", "gone.txt") }).restored).toHaveLength(1);
    expect(readFileSync(join(mount, "sub", "gone.txt"), "utf8")).toBe("bye\n");
    expect(() => undoRun("run4", { root, path: join(mount, "keep.txt") })).toThrow(/not a file run run4 changed/);
  });

  it("refuses a file that changed again after the run, unless forced", () => {
    const { mount, root } = setup();
    takeSnapshot("run5", [mount], { root });
    agentEdits(mount);
    recordChanges("run5", { root });
    writeFileSync(join(mount, "notes.txt"), "a person edited this afterwards\n");
    expect(listChanges("run5", { root }).changes.find((c) => c.path === "notes.txt")!.state).toBe("changed-since");

    const r = undoRun("run5", { root });
    expect(r.refused).toBe(true);
    expect(r.restored).toEqual([]);
    expect(r.skipped).toEqual([{ mount, path: "notes.txt", kind: "modified", reason: expect.stringMatching(/changed again/) }]);
    // Nothing was touched, not even the files that could have been restored.
    expect(existsSync(join(mount, "out", "deep", "report.md"))).toBe(true);
    expect(readFileSync(join(mount, "notes.txt"), "utf8")).toBe("a person edited this afterwards\n");

    const forced = undoRun("run5", { root, force: true });
    expect(forced.refused).toBe(false);
    expect(forced.restored).toHaveLength(4);
    expect(readFileSync(join(mount, "notes.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });
});

describe("pruning", () => {
  it("removes snapshots older than 14 days", () => {
    const { mount, root } = setup();
    const now = new Date("2026-11-17T12:00:00Z");
    takeSnapshot("old", [mount], { root, now: new Date("2026-11-01T12:00:00Z") });
    takeSnapshot("recent", [mount], { root, now: new Date("2026-11-10T12:00:00Z") });
    // No manifest: judged by the folder's age.
    mkdirSync(join(root, "broken"));
    utimesSync(join(root, "broken"), new Date("2026-10-01"), new Date("2026-10-01"));
    expect(pruneSnapshots({ root, now }).sort()).toEqual(["broken", "old"]);
    expect(readdirSync(root)).toEqual(["recent"]);
  });
});

describe("karuna changes / undo", () => {
  it("parses --run, --path and --force", () => {
    expect(parseUndoArgs("undo", ["--run", "r1", "--path", "C:\\data\\a.txt", "--force"])).toEqual({ run: "r1", path: "C:\\data\\a.txt", force: true });
    expect(parseUndoArgs("changes", ["--run", "r1"])).toEqual({ run: "r1", force: false });
    expect(() => parseUndoArgs("changes", ["--run", "r1", "--force"])).toThrow();
    expect(() => parseUndoArgs("undo", [])).toThrow(/--run/);
    expect(() => parseUndoArgs("undo", ["--run", "../etc"])).toThrow(/run id/);
  });

  it("prints JSON and exits non-zero when it refuses", () => {
    const { mount, root } = setup();
    takeSnapshot("run6", [mount], { root });
    agentEdits(mount);
    recordChanges("run6", { root });
    const tsx = join(import.meta.dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const cli = join(import.meta.dirname, "..", "src", "cli.ts");
    const karuna = (...args: string[]) => spawnSync(process.execPath, [tsx, cli, ...args], { encoding: "utf8", env: { ...process.env, KARUNA_SNAPSHOT_DIR: root } });

    const listed = karuna("changes", "--run", "run6");
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout).changes).toHaveLength(4);

    writeFileSync(join(mount, "notes.txt"), "edited again\n");
    const refused = karuna("undo", "--run", "run6");
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout)).toEqual({ restored: [], skipped: [{ mount, path: "notes.txt", kind: "modified", reason: expect.any(String) }] });
    expect(refused.stderr).toMatch(/^karuna · refused/m);

    const one = karuna("undo", "--run", "run6", "--path", join(mount, "out", "deep", "report.md"));
    expect(one.status).toBe(0);
    expect(JSON.parse(one.stdout)).toEqual({ restored: [{ mount, path: "out/deep/report.md", kind: "added" }], skipped: [] });

    const missing = karuna("changes", "--run", "nope");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/No snapshot for run nope/);
  }, 60_000);
});
