// Karuna in Claude Code and Cursor: each tool call the AI is about to make, translated into a
// Karuna request (shell, file, web, connector tool) and decided by the same engine as any agent.
//
// The coder's project folder is presented to the engine as ./workspace, so the level grants that
// cover a sandbox's workspace cover the project; anything outside it keeps its absolute path.
import type { Request } from "@prekaruna/engine";

/** Claude Code's own bookkeeping tools: no effect outside the conversation, never sent to Karuna. */
export const INTERNAL_TOOLS = new Set([
  "Task", "Agent", "TodoWrite", "TodoRead", "ExitPlanMode", "EnterPlanMode", "AskUserQuestion", "BashOutput", "KillShell",
  "KillBash", "SlashCommand", "Skill", "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "TaskOutput", "TaskStop",
]);

export interface HookCall {
  tool: string; // Claude Code's tool name, e.g. "Bash", "Edit", "mcp__github__create_issue"
  input: Record<string, unknown>;
  cwd: string; // the project folder
}

export type HookRequest =
  | { kind: "internal" }
  | { kind: "karuna" } // Karuna's own MCP tools: decided when they run
  | { kind: "request"; request: Request; summary: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");

function norm(p: string) {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** A path as the engine sees it: "workspace/<relative>" inside the project, else the absolute path. */
export function projectPath(path: string, cwd: string): string {
  const root = norm(cwd);
  let p = norm(path.trim());
  if (!p) return "workspace";
  const absolute = /^([a-z]:)?\//i.test(p);
  if (!absolute) p = `${root}/${p}`;
  // resolve . and .. so "../" can't sneak back out under a project-looking path
  const parts: string[] = [];
  const drive = /^[a-z]:/i.exec(p)?.[0] ?? "";
  for (const seg of p.slice(drive.length).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const resolved = `${drive}/${parts.join("/")}`;
  const rootResolved = norm(root);
  const lc = (x: string) => (drive ? x.toLowerCase() : x); // Windows paths ignore case
  if (lc(resolved) === lc(rootResolved)) return "workspace";
  if (lc(resolved).startsWith(`${lc(rootResolved)}/`)) return `workspace/${resolved.slice(rootResolved.length + 1)}`;
  return resolved;
}

/** Translate one tool call. Unknown built-in tools are treated as connector tools: they ask. */
export function hookRequest(agentId: string, call: HookCall): HookRequest {
  const { tool, input, cwd } = call;
  if (INTERNAL_TOOLS.has(tool)) return { kind: "internal" };
  const base = { agent: agentId, host: true } as const;
  const path = (k: string) => projectPath(str(input[k]), cwd);
  switch (tool) {
    case "Bash":
    case "PowerShell": {
      const command = str(input.command).trim();
      return { kind: "request", request: { ...base, tool: "shell", command }, summary: command.slice(0, 200) };
    }
    case "Read":
    case "NotebookRead":
      return { kind: "request", request: { ...base, tool: "file", fileOp: "read", path: path(input.file_path ? "file_path" : "notebook_path") }, summary: `read ${str(input.file_path || input.notebook_path)}` };
    case "Glob":
    case "Grep":
    case "LS": {
      const p = projectPath(str(input.path) || cwd, cwd);
      return { kind: "request", request: { ...base, tool: "file", fileOp: "read", path: p }, summary: `${tool.toLowerCase()} ${str(input.pattern) || str(input.path) || "."}` };
    }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const raw = str(input.file_path) || str(input.notebook_path);
      return { kind: "request", request: { ...base, tool: "file", fileOp: "write", path: projectPath(raw, cwd) }, summary: `${tool.toLowerCase()} ${raw}` };
    }
    case "WebFetch":
      return { kind: "request", request: { ...base, tool: "http", method: "GET", url: str(input.url) }, summary: `fetch ${str(input.url)}` };
    case "WebSearch":
      return { kind: "request", request: { ...base, tool: "tool", toolName: "claude:web_search", readOnly: true }, summary: `search "${str(input.query).slice(0, 120)}"` };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) {
    const server = mcp[1].toLowerCase();
    if (/^plugin_karuna_/.test(server)) return { kind: "karuna" };
    return { kind: "request", request: { ...base, tool: "tool", toolName: `${server}:${mcp[2].toLowerCase()}` }, summary: `${server} → ${mcp[2]}` };
  }
  return { kind: "request", request: { ...base, tool: "tool", toolName: `claude:${tool.toLowerCase()}` }, summary: tool };
}
