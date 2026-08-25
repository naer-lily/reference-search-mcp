import { fetchBuffer } from "../net.js";
import { buildQuery, type ProviderSearchOptions, type SearchProvider } from "./base.js";
import type { ImageResult } from "../types.js";

interface BingMeta {
  murl?: string;
  turl?: string;
  t?: string;
  pur?: string;
  mw?: number;
  mh?: number;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\\//g, "/");
}

/** Parse Bing Images async HTML (a.iusc elements with m="..." JSON). Exported for tests. */
export function parseBingHtml(html: string, max: number): ImageResult[] {
  const out: ImageResult[] = [];
  const re = /m="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    let meta: BingMeta;
    try {
      meta = JSON.parse(decodeHtmlEntities(m[1]!)) as BingMeta;
    } catch {
      continue;
    }
    if (!meta.murl || !meta.turl) continue;
    out.push({
      thumbUrl: meta.turl,
      fullUrl: meta.murl,
      title: meta.t ?? "",
      sourceDomain: safeDomain(meta.pur),
      provider: "bing",
      width: meta.mw,
      height: meta.mh,
    });
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
 * Bing Images via the async endpoint. Zero-config, no API key.
 */
export class BingProvider implements SearchProvider {
  readonly name = "bing";

  async search(keywords: string[], opts: ProviderSearchOptions): Promise<ImageResult[]> {
    const q = buildQuery(keywords);
    const first = (opts.page ?? 0) * opts.count;
    const url =
      `https://www.bing.com/images/async?q=${encodeURIComponent(q)}` +
      `&first=${first}&count=${opts.count}&mmasync=1` +
      (opts.safeSearch ? "&adlt=strict" : "");
    const res = await fetchBuffer(url, {
      timeoutMs: opts.timeoutMs,
      headers: { Accept: "text/html" },
      retries: 2,
    });
    return parseBingHtml(res.buffer.toString("utf8"), opts.count);
  }
}
