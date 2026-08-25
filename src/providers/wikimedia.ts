import { fetchBuffer } from "../net.js";
import { buildQuery, type ProviderSearchOptions, type SearchProvider } from "./base.js";
import type { ImageResult } from "../types.js";

interface WikiPage {
  title?: string;
  imageinfo?: {
    url?: string;
    thumburl?: string;
    width?: number;
    height?: number;
    extmetadata?: {
      LicenseShortName?: { value?: string };
    };
  }[];
}

interface WikiResponse {
  query?: { pages?: Record<string, WikiPage> };
  error?: { info?: string };
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
}

/** Parse the Wikimedia Commons API response. Exported for tests. */
export function parseWikimediaJson(json: WikiResponse, max: number): ImageResult[] {
  const pages = Object.values(json.query?.pages ?? {});
  const out: ImageResult[] = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii?.url || !ii.thumburl) continue;
    out.push({
      thumbUrl: ii.thumburl,
      fullUrl: ii.url,
      title: p.title ?? "",
      sourceDomain: "commons.wikimedia.org",
      provider: "wikimedia",
      license: stripHtml(ii.extmetadata?.LicenseShortName?.value ?? ""),
      width: ii.width,
      height: ii.height,
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Wikimedia Commons API — free, no key, license metadata included.
 */
export class WikimediaProvider implements SearchProvider {
  readonly name = "wikimedia";

  async search(keywords: string[], opts: ProviderSearchOptions): Promise<ImageResult[]> {
    const q = buildQuery(keywords);
    const url =
      "https://commons.wikimedia.org/w/api.php?action=query&generator=search" +
      `&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=${opts.count}` +
      "&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=300&format=json&origin=*";
    const res = await fetchBuffer(url, {
      timeoutMs: opts.timeoutMs,
      headers: { Accept: "application/json" },
      retries: 2,
    });
    let json: WikiResponse;
    try {
      json = JSON.parse(res.buffer.toString("utf8")) as WikiResponse;
    } catch {
      throw new Error("wikimedia: invalid API JSON");
    }
    if (json.error?.info) throw new Error(`wikimedia: ${json.error.info}`);
    return parseWikimediaJson(json, opts.count);
  }
}
