import { fetchBuffer } from "../net.js";
import { buildQuery, type ProviderSearchOptions, type SearchProvider } from "./base.js";
import type { ImageResult } from "../types.js";

interface SerperImage {
  imageUrl?: string;
  thumbnailUrl?: string;
  title?: string;
  imageWidth?: number;
  imageHeight?: number;
  source?: string;
  link?: string;
}

interface SerperResponse {
  images?: SerperImage[];
}

function safeDomain(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Serper.dev Google Image Search API. Requires SERPER_API_KEY.
 */
export class SerperProvider implements SearchProvider {
  readonly name = "serper";

  constructor(private readonly apiKey: string) {}

  async search(keywords: string[], opts: ProviderSearchOptions): Promise<ImageResult[]> {
    const page = (opts.page ?? 0) + 1;
    const body = JSON.stringify({ q: buildQuery(keywords), num: opts.count, page });
    const res = await fetchBuffer("https://google.serper.dev/images", {
      timeoutMs: opts.timeoutMs,
      headers: {
        "X-API-KEY": this.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      retries: 2,
    });
    let json: SerperResponse;
    try {
      json = JSON.parse(res.buffer.toString("utf8")) as SerperResponse;
    } catch {
      throw new Error("serper: invalid API JSON");
    }
    const out: ImageResult[] = [];
    for (const r of json.images ?? []) {
      if (!r.imageUrl) continue;
      out.push({
        thumbUrl: r.thumbnailUrl ?? r.imageUrl,
        fullUrl: r.imageUrl,
        title: r.title ?? "",
        sourceDomain: safeDomain(r.link) || (r.source ?? "serper"),
        provider: "serper",
        width: r.imageWidth,
        height: r.imageHeight,
      });
      if (out.length >= opts.count) break;
    }
    return out;
  }
}
