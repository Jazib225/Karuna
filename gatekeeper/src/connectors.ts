// The team's connectors (other MCP servers: GitHub, Gmail, …), reached only through Karuna.
//
// A connector is added by a vote (a capability rule `connector:<name>` whose target is the server's
// URL). Karuna connects to it, lists its tools and offers them to chat apps through its own MCP
// endpoint as `<name>__<tool>`; every call is decided by the team's rules first. A key named like
// the connector (Keys page) is sent as its bearer token; the chat app never holds it.
//
// Tool definitions come from outside the org, so Karuna remembers each tool as first seen after
// the team approved the connector. If a connector later changes a tool's description, inputs or
// hints (a known attack: a tool quietly rewritten), calls to it are held until a member reviews it.
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ConnectorDef {
  name: string; // lowercase, [a-z0-9-]
  url: string;
  key?: string | null; // bearer token, if the team stored one
}

export interface ConnectorTool {
  connector: string;
  tool: Tool; // as the connector describes it
  fingerprint: string;
}

/** What identifies a tool's behavior: if any of it changes, the team reviews it again. */
export function toolFingerprint(t: Tool): string {
  return createHash("sha256")
    .update(JSON.stringify({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? {}, annotations: t.annotations ?? {} }))
    .digest("hex");
}

export const SEP = "__";
export const exposedName = (connector: string, tool: string) => `${connector}${SEP}${tool}`;
export function splitName(name: string): { connector: string; tool: string } | null {
  const i = name.indexOf(SEP);
  return i > 0 ? { connector: name.slice(0, i), tool: name.slice(i + SEP.length) } : null;
}

/** Talks MCP to each connector, with a short cache of their tool lists. */
export class ConnectorClients {
  private cache = new Map<string, { at: number; tools: Tool[] }>();
  constructor(private readonly ttlMs = 60_000, private readonly connect = defaultConnect) {}

  async listTools(c: ConnectorDef): Promise<Tool[]> {
    const hit = this.cache.get(c.name);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.tools;
    const client = await this.connect(c);
    try {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && tools.length < 500);
      this.cache.set(c.name, { at: Date.now(), tools });
      return tools;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async callTool(c: ConnectorDef, tool: string, args: Record<string, unknown>) {
    const client = await this.connect(c);
    try {
      return await client.callTool({ name: tool, arguments: args });
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  forget(name?: string) {
    if (name) this.cache.delete(name);
    else this.cache.clear();
  }
}

async function defaultConnect(c: ConnectorDef): Promise<Client> {
  const client = new Client({ name: "karuna-gatekeeper", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(c.url), {
    requestInit: c.key ? { headers: { authorization: `Bearer ${c.key}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}
