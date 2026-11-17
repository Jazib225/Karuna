// Karuna's own web tools for chat apps: public addresses only, readable text, search results.
import { describe, it, expect } from "vitest";
import { WebTools, htmlToText, isPublicAddress, parseSearch } from "../src/web.ts";

const lookup = async (host: string) => (host === "intranet.example" ? ["192.168.1.20"] : host === "mixed.example" ? ["93.184.216.34", "127.0.0.1"] : ["93.184.216.34"]);

describe("web tools", () => {
  it("only public addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.9", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("refuses local, private and non-http addresses, even behind a public name", async () => {
    const w = new WebTools(fetch, lookup);
    await expect(w.checkPublic("http://127.0.0.1:8787/api")).rejects.toThrow(/private or local/);
    await expect(w.checkPublic("http://intranet.example/")).rejects.toThrow(/private or local/);
    await expect(w.checkPublic("http://mixed.example/")).rejects.toThrow(/private or local/);
    await expect(w.checkPublic("file:///etc/passwd")).rejects.toThrow(/Only http/);
    await expect(w.checkPublic("https://user:pw@example.com/")).rejects.toThrow(/username/);
    expect((await w.checkPublic("https://example.com/a?b=1")).href).toBe("https://example.com/a?b=1");
  });

  it("reads a page as text, and hands back redirects instead of following them", async () => {
    const fake = (async (u: URL | string) => {
      const url = String(u);
      if (url.endsWith("/moved")) return new Response(null, { status: 301, headers: { location: "/new" } });
      return new Response("<html><head><style>x{}</style><script>bad()</script></head><body><h1>Hello &amp; welcome</h1><p>Line two</p></body></html>", { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const w = new WebTools(fake, lookup);
    const page = await w.fetchPage("https://example.com/");
    expect(page.text).toBe("Hello & welcome\nLine two");
    const moved = await w.fetchPage("https://example.com/moved");
    expect(moved.redirect).toBe("https://example.com/new");
    expect(htmlToText("a<br>b &#65;")).toBe("a\nb A");
  });

  it("parses search results", () => {
    const html = `<div class="result results_links results_links_deep web-result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=x">Example <b>Docs</b></a></h2><a class="result__snippet" href="#">The <b>docs</b> page.</a></div>
<div class="result results_links results_links_deep web-result"><a class="result__a" href="https://other.example/">Other</a><a class="result__snippet">Second.</a></div>`;
    expect(parseSearch(html)).toEqual([
      { title: "Example Docs", url: "https://example.com/docs", snippet: "The docs page." },
      { title: "Other", url: "https://other.example/", snippet: "Second." },
    ]);
  });
});
