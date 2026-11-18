// Undo for agent file changes. Before a run, every writable mount is copied into
// ~/.karuna/snapshots/<runId>/; after the box exits the runner records what the agent added,
// modified or deleted (with a unified diff for small text files) and the state each changed file
// was left in. `karuna changes` and `karuna undo` read that record back, and undo refuses to touch
// a file that changed again after the run unless forced.
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  readlinkSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_DIFF_INPUT_BYTES = 1024 * 1024; // larger text files are listed without a diff
export const MAX_DIFF_BYTES = 64 * 1024; // one diff, after which it is cut
export const MAX_DIFF_TOTAL_BYTES = 2 * 1024 * 1024; // all diffs of one run
export const PRUNE_AFTER_DAYS = 14;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const MANIFEST = "manifest.json";

export type ChangeKind = "added" | "modified" | "deleted";

export interface FileEntry {
  size: number;
  mtimeMs: number;
  mode: number;
  sha256: string;
}

export interface Skipped {
  path: string;
  reason: string;
}

export interface MountSnapshot {
  mount: string; // absolute host path
  dirs: string[];
  files: Record<string, FileEntry>;
  skipped: Skipped[];
}

/** One change as it is reported (and POSTed to the Gatekeeper). */
export interface Change {
  mount: string;
  path: string; // relative to the mount, "/"-separated
  kind: ChangeKind;
  diff: string | null;
  binary: boolean;
}

/** A change as stored: plus the file's hash before and right after the run (null: no file). */
export interface StoredChange extends Change {
  before: string | null;
  after: string | null;
}

export interface Manifest {
  version: 1;
  runId: string;
  createdAt: string;
  finishedAt: string | null;
  mounts: MountSnapshot[];
  changes: StoredChange[] | null; // null until the run has ended
}

export type ChangeState = "as-run" | "changed-since" | "undone";

export interface Options {
  root?: string;
  maxFileBytes?: number;
  now?: Date;
}

export const defaultSnapshotRoot = () => process.env.KARUNA_SNAPSHOT_DIR || join(homedir(), ".karuna", "snapshots");
const rootOf = (o: Options) => resolve(o.root ?? defaultSnapshotRoot());

export function validRunId(id: string) {
  return /^[\w.-]{1,80}$/.test(id) && !/^\.+$/.test(id);
}

const runDir = (root: string, runId: string) => {
  if (!validRunId(runId)) throw new Error(`Not a run id: ${runId}`);
  return join(root, runId);
};

// ---------------------------------------------------------------- reading the tree

type Seen = { kind: "file"; size: number; mtimeMs: number; mode: number } | { kind: "link"; target: string };

interface Walk {
  dirs: string[];
  entries: Map<string, Seen>;
  skipped: Skipped[];
}

/** Every file and link under ROOT, without following links; node_modules and .git are left out. */
function walk(root: string): Walk {
  const out: Walk = { dirs: [], entries: new Map(), skipped: [] };
  const visit = (rel: string) => {
    const abs = rel ? join(root, rel) : root;
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch (e) {
      if (rel) out.skipped.push({ path: rel, reason: `unreadable: ${(e as Error).message}` });
      return;
    }
    for (const name of names.sort()) {
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(join(abs, name));
      } catch (e) {
        out.skipped.push({ path: r, reason: `unreadable: ${(e as Error).message}` });
        continue;
      }
      if (st.isSymbolicLink()) {
        let target = "";
        try {
          target = readlinkSync(join(abs, name));
        } catch {
          /* hash the empty target */
        }
        out.entries.set(r, { kind: "link", target });
      } else if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) {
          out.skipped.push({ path: r, reason: name });
          continue;
        }
        out.dirs.push(r);
        visit(r);
      } else if (st.isFile()) {
        out.entries.set(r, { kind: "file", size: st.size, mtimeMs: st.mtimeMs, mode: st.mode & 0o777 });
      }
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) visit("");
  return out;
}

function hashFile(file: string): string {
  const h = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

const hashLink = (target: string) => createHash("sha256").update(`link:${target}`).digest("hex");

/** The hash of what is at ABS now, or null when nothing is there. */
function currentHash(abs: string): string | null {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return hashLink(readlinkSync(abs));
  if (st.isFile()) return hashFile(abs);
  return "dir";
}

// ---------------------------------------------------------------- snapshot

function writeManifest(dir: string, m: Manifest) {
  const tmp = join(dir, `${MANIFEST}.tmp`);
  writeFileSync(tmp, JSON.stringify(m));
  renameSync(tmp, join(dir, MANIFEST));
}

export function readManifest(runId: string, o: Options = {}): Manifest {
  const file = join(runDir(rootOf(o), runId), MANIFEST);
  if (!existsSync(file)) throw new Error(`No snapshot for run ${runId} on this machine`);
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

const copyPath = (root: string, runId: string, mountIndex: number, rel: string) => join(runDir(root, runId), "files", String(mountIndex), ...rel.split("/"));

/** Copy every writable mount into <root>/<runId>/ and write its manifest. */
export function takeSnapshot(runId: string, mounts: string[], o: Options = {}): Manifest {
  const root = rootOf(o);
  const max = o.maxFileBytes ?? MAX_FILE_BYTES;
  const dir = runDir(root, runId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const m: Manifest = { version: 1, runId, createdAt: (o.now ?? new Date()).toISOString(), finishedAt: null, mounts: [], changes: null };
  mounts.forEach((mountPath, i) => {
    const mount = resolve(mountPath);
    const w = walk(mount);
    const snap: MountSnapshot = { mount, dirs: w.dirs, files: {}, skipped: [...w.skipped] };
    if (existsSync(mount) && !statSync(mount).isDirectory()) snap.skipped.push({ path: "", reason: "not a folder" });
    for (const [rel, e] of w.entries) {
      if (e.kind === "link") {
        snap.skipped.push({ path: rel, reason: "link" });
        continue;
      }
      if (e.size > max) {
        snap.skipped.push({ path: rel, reason: `over ${Math.round(max / 1024 / 1024)} MB (${e.size} bytes)` });
        continue;
      }
      try {
        const data = readFileSync(join(mount, rel));
        const to = copyPath(root, runId, i, rel);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, data);
        snap.files[rel] = { size: data.length, mtimeMs: e.mtimeMs, mode: e.mode, sha256: createHash("sha256").update(data).digest("hex") };
      } catch (err) {
        snap.skipped.push({ path: rel, reason: `unreadable: ${(err as Error).message}` });
      }
    }
    m.mounts.push(snap);
  });
  writeManifest(dir, m);
  return m;
}

/** Give a snapshot taken under a temporary id its run's id. */
export function renameSnapshot(fromId: string, toId: string, o: Options = {}): void {
  const root = rootOf(o);
  if (fromId === toId) return;
  const from = runDir(root, fromId);
  const to = runDir(root, toId);
  rmSync(to, { recursive: true, force: true });
  renameSync(from, to);
  const m = readManifest(toId, o);
  m.runId = toId;
  writeManifest(to, m);
}

export function removeSnapshot(runId: string, o: Options = {}): void {
  rmSync(runDir(rootOf(o), runId), { recursive: true, force: true });
}

/** Delete snapshots older than PRUNE_AFTER_DAYS. Returns the run ids removed. */
export function pruneSnapshots(o: Options & { maxAgeDays?: number } = {}): string[] {
  const root = rootOf(o);
  if (!existsSync(root)) return [];
  const cutoff = (o.now ?? new Date()).getTime() - (o.maxAgeDays ?? PRUNE_AFTER_DAYS) * 86_400_000;
  const removed: string[] = [];
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    let created: number;
    try {
      if (!statSync(dir).isDirectory()) continue;
      const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Manifest;
      created = Date.parse(m.createdAt);
      if (Number.isNaN(created)) throw new Error("no date");
    } catch {
      try {
        created = statSync(dir).mtimeMs;
      } catch {
        continue;
      }
    }
    if (created < cutoff) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(id);
    }
  }
  return removed;
}

// ---------------------------------------------------------------- diffs

type Op = { t: " " | "-" | "+"; line: string };
const NOEOL = "\u0000noeol";

function toLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  else lines[lines.length - 1] += NOEOL;
  return lines;
}

/** Myers' diff over lines; null when the edit is larger than maxD (the caller replaces wholesale). */
function myers(a: string[], b: string[], maxD = 1000): Op[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxD);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        const ops: Op[] = [];
        let cx = n;
        let cy = m;
        for (let dd = d; dd >= 0; dd--) {
          const tv = trace[dd];
          const kk = cx - cy;
          const prevK = kk === -dd || (kk !== dd && tv[off + kk - 1] < tv[off + kk + 1]) ? kk + 1 : kk - 1;
          const prevX = tv[off + prevK];
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) {
            ops.push({ t: " ", line: a[cx - 1] });
            cx--;
            cy--;
          }
          if (dd > 0) {
            if (cx === prevX) ops.push({ t: "+", line: b[cy - 1] });
            else ops.push({ t: "-", line: a[cx - 1] });
          }
          cx = prevX;
          cy = prevY;
        }
        return ops.reverse();
      }
    }
  }
  return null;
}

function diffLines(a: string[], b: string[]): Op[] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const ma = a.slice(s, ea);
  const mb = b.slice(s, eb);
  const mid = myers(ma, mb) ?? [...ma.map((line) => ({ t: "-" as const, line })), ...mb.map((line) => ({ t: "+" as const, line }))];
  return [
    ...a.slice(0, s).map((line) => ({ t: " " as const, line })),
    ...mid,
    ...a.slice(ea).map((line) => ({ t: " " as const, line })),
  ];
}

/** A unified diff (3 lines of context) of OLD → NEW, or "" when they are the same. */
export function unifiedDiff(oldText: string | null, newText: string | null, path: string, context = 3): string {
  const ops = diffLines(toLines(oldText ?? ""), toLines(newText ?? ""));
  const changed = ops.map((o, i) => (o.t === " " ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return "";
  // Line numbers before each op.
  const pos: [number, number][] = [];
  let ai = 0;
  let bi = 0;
  for (const o of ops) {
    pos.push([ai, bi]);
    if (o.t !== "+") ai++;
    if (o.t !== "-") bi++;
  }
  const out = [oldText === null ? "--- /dev/null" : `--- a/${path}`, newText === null ? "+++ /dev/null" : `+++ b/${path}`];
  let i = 0;
  while (i < changed.length) {
    const start = Math.max(0, changed[i] - context);
    let last = changed[i];
    while (i + 1 < changed.length && changed[i + 1] - last <= 2 * context) last = changed[++i];
    i++;
    const end = Math.min(ops.length, last + context + 1);
    const slice = ops.slice(start, end);
    const aLen = slice.filter((o) => o.t !== "+").length;
    const bLen = slice.filter((o) => o.t !== "-").length;
    const aStart = aLen ? pos[start][0] + 1 : pos[start][0];
    const bStart = bLen ? pos[start][1] + 1 : pos[start][1];
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of slice) {
      if (o.line.endsWith(NOEOL)) out.push(`${o.t}${o.line.slice(0, -NOEOL.length)}`, "\\ No newline at end of file");
      else out.push(`${o.t}${o.line}`);
    }
  }
  return `${out.join("\n")}\n`;
}

function asText(buf: Buffer): string | null {
  if (buf.subarray(0, 8000).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function capDiff(d: string): string {
  if (Buffer.byteLength(d) <= MAX_DIFF_BYTES) return d;
  let cut = Buffer.from(d).subarray(0, MAX_DIFF_BYTES).toString("utf8");
  cut = cut.slice(0, cut.lastIndexOf("\n") + 1);
  return `${cut}... diff cut at ${MAX_DIFF_BYTES} bytes\n`;
}

/** Old/new contents → diff and binary flag. Files over MAX_DIFF_INPUT_BYTES get no diff. */
function describe(oldFile: string | null, newFile: string | null, newSeen: Seen | undefined, path: string): { diff: string | null; binary: boolean } {
  const read = (f: string | null) => {
    if (!f) return { text: null, binary: false, big: false };
    if (statSync(f).size > MAX_DIFF_INPUT_BYTES) return { text: null, binary: false, big: true };
    const buf = readFileSync(f);
    const text = asText(buf);
    return { text, binary: text === null, big: false };
  };
  if (newSeen?.kind === "link") return { diff: null, binary: false };
  const o = read(oldFile);
  const n = read(newFile);
  if (o.binary || n.binary) return { diff: null, binary: true };
  if (o.big || n.big) return { diff: null, binary: false };
  return { diff: capDiff(unifiedDiff(oldFile ? o.text : null, newFile ? n.text : null, path)), binary: false };
}

// ---------------------------------------------------------------- changes

/** What changed in each snapshotted mount, compared with the disk now. */
export function computeChanges(m: Manifest, o: Options = {}): StoredChange[] {
  const root = rootOf(o);
  const out: StoredChange[] = [];
  let budget = MAX_DIFF_TOTAL_BYTES;
  m.mounts.forEach((snap, i) => {
    const now = walk(snap.mount);
    const ignored = new Set(snap.skipped.map((s) => s.path));
    const isIgnored = (rel: string) => {
      if (ignored.has(rel)) return true;
      for (let p = rel; p.includes("/"); ) {
        p = p.slice(0, p.lastIndexOf("/"));
        if (ignored.has(p)) return true;
      }
      return false;
    };
    const paths = [...new Set([...Object.keys(snap.files), ...now.entries.keys()])].sort();
    for (const rel of paths) {
      if (isIgnored(rel)) continue;
      const was = snap.files[rel];
      const seen = now.entries.get(rel);
      const abs = join(snap.mount, ...rel.split("/"));
      const after = seen ? (seen.kind === "link" ? hashLink(seen.target) : hashFile(abs)) : null;
      const before = was ? was.sha256 : null;
      if (before === after) continue;
      const kind: ChangeKind = !was ? "added" : !seen ? "deleted" : "modified";
      const d = describe(was ? copyPath(root, m.runId, i, rel) : null, seen && seen.kind === "file" ? abs : null, seen, rel);
      let diff = d.diff;
      if (diff !== null) {
        const size = Buffer.byteLength(diff);
        if (size > budget) diff = null;
        else budget -= size;
      }
      out.push({ mount: snap.mount, path: rel, kind, diff, binary: d.binary, before, after });
    }
  });
  return out;
}

/** After the box exits: record what changed and the state it was left in. */
export function recordChanges(runId: string, o: Options = {}): StoredChange[] {
  const m = readManifest(runId, o);
  m.changes = computeChanges(m, o);
  m.finishedAt = (o.now ?? new Date()).toISOString();
  writeManifest(runDir(rootOf(o), runId), m);
  return m.changes;
}

const publicChange = (c: StoredChange): Change => ({ mount: c.mount, path: c.path, kind: c.kind, diff: c.diff, binary: c.binary });
export const toReport = (cs: StoredChange[]): Change[] => cs.map(publicChange);

function stateOf(c: StoredChange): ChangeState {
  const cur = currentHash(join(c.mount, ...c.path.split("/")));
  if (cur === c.before) return "undone";
  if (cur === c.after) return "as-run";
  return "changed-since";
}

export interface ChangesReport {
  runId: string;
  createdAt: string;
  finishedAt: string | null;
  changes: (Change & { state: ChangeState })[];
  skipped: (Skipped & { mount: string })[];
}

/** `karuna changes`: the run's recorded changes and where each file stands now. */
export function listChanges(runId: string, o: Options = {}): ChangesReport {
  const m = readManifest(runId, o);
  const changes = m.changes ?? computeChanges(m, o); // a run that never finished: compare with now
  return {
    runId: m.runId, createdAt: m.createdAt, finishedAt: m.finishedAt,
    changes: changes.map((c) => ({ ...publicChange(c), state: m.changes ? stateOf(c) : "as-run" })),
    skipped: m.mounts.flatMap((s) => s.skipped.map((x) => ({ mount: s.mount, ...x }))),
  };
}

// ---------------------------------------------------------------- undo

export interface UndoItem {
  mount: string;
  path: string;
  kind: ChangeKind;
}

export interface UndoResult {
  restored: UndoItem[];
  skipped: (UndoItem & { reason: string })[];
  refused: boolean; // something changed again since the run and --force wasn't given: nothing was touched
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** True when any existing folder between MOUNT and REL is a link: never write through one. */
function throughLink(mount: string, rel: string): boolean {
  const parts = rel.split("/");
  let p = mount;
  for (const part of parts.slice(0, -1)) {
    p = join(p, part);
    try {
      if (lstatSync(p).isSymbolicLink()) return true;
    } catch {
      return false; // missing from here on: it will be created as real folders
    }
  }
  return false;
}

/**
 * Put a run's changes back: modified and deleted files from the snapshot, added files removed.
 * PATH (the file's absolute host path) limits it to one file. If a file changed again after the
 * run ended, nothing is touched unless FORCE.
 */
export function undoRun(runId: string, opts: Options & { path?: string; force?: boolean } = {}): UndoResult {
  const root = rootOf(opts);
  const m = readManifest(runId, opts);
  const changes = m.changes ?? computeChanges(m, opts);
  const post = !!m.changes;
  let targets = changes;
  if (opts.path) {
    targets = changes.filter((c) => samePath(join(c.mount, ...c.path.split("/")), opts.path!));
    if (!targets.length) throw new Error(`${opts.path} is not a file run ${runId} changed`);
  }
  const res: UndoResult = { restored: [], skipped: [], refused: false };
  const todo: StoredChange[] = [];
  const conflicts: (UndoItem & { reason: string })[] = [];
  for (const c of targets) {
    const item = { mount: c.mount, path: c.path, kind: c.kind };
    const cur = currentHash(join(c.mount, ...c.path.split("/")));
    if (cur === c.before) res.skipped.push({ ...item, reason: "already undone" });
    else if (post && cur !== c.after && !opts.force) conflicts.push({ ...item, reason: "changed again since the run ended (use --force to restore it anyway)" });
    else todo.push(c);
  }
  if (conflicts.length) return { restored: [], skipped: [...res.skipped, ...conflicts], refused: true };

  const mountIndex = new Map(m.mounts.map((s, i) => [s.mount, i]));
  // Removals first: an added link may sit where a deleted folder's files go back.
  todo.sort((a, b) => Number(b.kind === "added") - Number(a.kind === "added"));
  for (const c of todo) {
    const item = { mount: c.mount, path: c.path, kind: c.kind };
    const abs = join(c.mount, ...c.path.split("/"));
    try {
      if (throughLink(c.mount, c.path)) throw new Error("its folder is now a link");
      if (c.kind === "added") {
        const st = lstatSync(abs, { throwIfNoEntry: false });
        if (st?.isDirectory()) rmSync(abs, { recursive: true, force: true });
        else if (st) unlinkSync(abs);
        removeEmptyParents(m.mounts[mountIndex.get(c.mount)!], c.path);
      } else {
        const i = mountIndex.get(c.mount)!;
        const entry = m.mounts[i].files[c.path];
        const data = readFileSync(copyPath(root, m.runId, i, c.path));
        const st = lstatSync(abs, { throwIfNoEntry: false });
        if (st?.isSymbolicLink()) unlinkSync(abs); // never write through a link
        else if (st?.isDirectory()) rmSync(abs, { recursive: true, force: true });
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, data);
        try {
          if (process.platform !== "win32") chmodSync(abs, entry.mode);
          utimesSync(abs, new Date(), new Date(entry.mtimeMs));
        } catch {
          /* contents are what matter */
        }
      }
      res.restored.push(item);
    } catch (e) {
      res.skipped.push({ ...item, reason: (e as Error).message });
    }
  }
  return res;
}

/** After removing an added file, remove the folders the run created that are now empty. */
function removeEmptyParents(snap: MountSnapshot, rel: string) {
  const existed = new Set(snap.dirs);
  for (let p = rel; p.includes("/"); ) {
    p = p.slice(0, p.lastIndexOf("/"));
    if (existed.has(p)) return;
    try {
      rmdirSync(join(snap.mount, ...p.split("/")));
    } catch {
      return; // not empty
    }
  }
}
