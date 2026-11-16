// Karuna's own web tools for chat apps (web_search, web_fetch), so a team can turn off the chat
// app's built-in web tools and lose nothing: the same reading, but every request follows the team's
// rules. The Gatekeeper makes the request itself, so it never reaches this machine's private network
// (the console, the router, cloud metadata): every address a host resolves to must be public.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 2_000_000;
const MAX_TEXT = 20_000;
const TIMEOUT_MS = 15_000;
const UA = "Karuna/1.0 (+web tool for a governed chat agent)";

export type Lookup = (host: string) => Promise<string[]>;
const dnsLookup: Lookup = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** Loopback, private, link-local, CGNAT, multicast and other non-public ranges (v4 and v6). */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (x === "::" || x === "::1") return false;
    if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff")) return false;
    return true;
  }
  return false;
}

/** Plain text from HTML: scripts, styles and tags out, entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface Page { status: number; url: string; text: string; redirect?: string; truncated: boolean }
export interface SearchHit { title: string; url: string; snippet: string }

export const searchUrl = (query: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

export class WebTools {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly resolve: Lookup = dnsLookup) {}

  /** Throws when the URL isn't http(s) or its host resolves to a non-public address. */
  async checkPublic(raw: string): Promise<URL> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error("That isn't a valid URL");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http and https addresses");
    if (u.username || u.password) throw new Error("Addresses with a username or password aren't allowed");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const ips = isIP(host) ? [host] : await this.resolve(host).catch(() => [] as string[]);
    if (!ips.length) throw new Error(`Couldn't find ${host}`);
    if (!ips.every(isPublicAddress)) throw new Error("Karuna doesn't fetch private or local network addresses");
    return u;
  }

  /** One GET, no redirects followed (each hop is a new request the team's rules decide). */
  async fetchPage(raw: string): Promise<Page> {
    const u = await this.checkPublic(raw);
    const res = await this.fetchImpl(u, { method: "GET", redirect: "manual", headers: { "user-agent": UA, accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get("location");
      return { status: res.status, url: u.href, text: "", redirect: to ? new URL(to, u).href : undefined, truncated: false };
    }
    const type = res.headers.get("content-type") ?? "";
    if (type && !/text|json|xml|javascript/i.test(type)) return { status: res.status, url: u.href, text: `(${type} content, not shown)`, truncated: false };
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size >= MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const text = /html/i.test(type) || /^\s*</.test(body) ? htmlToText(body) : body;
    return { status: res.status, url: u.href, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT || size >= MAX_BYTES };
  }

  /** Web results from DuckDuckGo's HTML page (no key needed). */
  async search(query: string, max = 8): Promise<SearchHit[]> {
    const res = await this.fetchImpl(searchUrl(query), { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    return parseSearch(await res.text()).slice(0, max);
  }
}

/** Results from DuckDuckGo's HTML results page. */
export function parseSearch(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/class="result results_links/).slice(1);
  for (const b of blocks) {
    const a = b.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, "&");
    const wrapped = url.match(/[?&]uddg=([^&]+)/);
    if (wrapped) url = decodeURIComponent(wrapped[1]);
    if (url.startsWith("//")) url = `https:${url}`;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snip = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    hits.push({ title: htmlToText(a[2]), url, snippet: snip ? htmlToText(snip[1]) : "" });
  }
  return hits;
}
