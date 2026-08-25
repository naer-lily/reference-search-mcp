import { fetchBuffer } from "../net.js";
import { buildQuery, ProviderError, type ProviderSearchOptions, type SearchProvider } from "./base.js";
import type { ImageResult } from "../types.js";

export interface DdgImage {
  image?: string;
  thumbnail?: string;
  title?: string;
  url?: string;
  width?: number;
  height?: number;
}

/** Extract the vqd token from the DuckDuckGo search page HTML. Exported for tests. */
export function extractVqd(html: string): string | null {
  const m = /vqd=["']([^"']+)["']/.exec(html) ?? /vqd=([0-9-]+)/.exec(html);
  return m ? m[1]! : null;
}

/** Parse i.js JSON payload into ImageResults. Exported for tests. */
export function parseDdgJson(json: { results?: DdgImage[] }, max: number): ImageResult[] {
  const out: ImageResult[] = [];
  for (const r of json.results ?? []) {
    if (!r.image || !r.thumbnail) continue;
    out.push({
      thumbUrl: r.thumbnail,
      fullUrl: r.image,
      title: r.title ?? "",
      sourceDomain: safeDomain(r.url),
      provider: "ddg",
      width: r.width,
      height: r.height,
    });
    if (out.length >= max) break;
  }
  return out;
}

function safeDomain(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * DuckDuckGo image search (i.js endpoint). Requires a vqd token fetched
 * from the HTML search page. Zero-config, no API key.
 */
export class DuckDuckGoProvider implements SearchProvider {
  readonly name = "ddg";

  async search(keywords: string[], opts: ProviderSearchOptions): Promise<ImageResult[]> {
    const q = buildQuery(keywords);
    const vqd = await this.fetchVqd(q, opts);
    const safe = opts.safeSearch ? "1" : "-1";
    const url = `https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(q)}&vqd=${encodeURIComponent(vqd)}&p=${safe}`;
    const res = await fetchBuffer(url, {
      timeoutMs: opts.timeoutMs,
      headers: { Accept: "application/json" },
      retries: 2,
    });
    let json: { results?: DdgImage[] };
    try {
      json = JSON.parse(res.buffer.toString("utf8"));
    } catch {
      throw new ProviderError("ddg: invalid i.js response JSON", "ddg");
    }
    return parseDdgJson(json, opts.count);
  }

  private async fetchVqd(q: string, opts: ProviderSearchOptions): Promise<string> {
    const res = await fetchBuffer(
      `https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`,
      { timeoutMs: opts.timeoutMs, retries: 2 },
    );
    const html = res.buffer.toString("utf8");
    const vqd = extractVqd(html);
    if (!vqd) throw new ProviderError("ddg: could not extract vqd token", "ddg");
    return vqd;
  }
}
