import { fetchBuffer } from "../net.js";
import { buildQuery, type ProviderSearchOptions, type SearchProvider } from "./base.js";
import type { ImageResult } from "../types.js";

interface OpenverseImage {
  url?: string;
  thumbnail?: string;
  title?: string;
  license?: string;
  source?: string;
  width?: number;
  height?: number;
  foreign_landing_url?: string;
}

interface OpenverseResponse {
  results?: OpenverseImage[];
}

function safeDomain(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Openverse API (CC-licensed images). Requires an anonymous-access token in
 * OPENVERSE_TOKEN. Only instantiated when the token is configured.
 */
export class OpenverseProvider implements SearchProvider {
  readonly name = "openverse";

  constructor(private readonly token: string) {}

  async search(keywords: string[], opts: ProviderSearchOptions): Promise<ImageResult[]> {
    const q = buildQuery(keywords);
    const page = (opts.page ?? 0) + 1;
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${opts.count}&page=${page}`;
    const res = await fetchBuffer(url, {
      timeoutMs: opts.timeoutMs,
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
      retries: 2,
    });
    let json: OpenverseResponse;
    try {
      json = JSON.parse(res.buffer.toString("utf8")) as OpenverseResponse;
    } catch {
      throw new Error("openverse: invalid API JSON");
    }
    const out: ImageResult[] = [];
    for (const r of json.results ?? []) {
      if (!r.url) continue;
      out.push({
        thumbUrl: r.thumbnail ?? r.url,
        fullUrl: r.url,
        title: r.title ?? "",
        sourceDomain: safeDomain(r.foreign_landing_url) || (r.source ?? "openverse"),
        provider: "openverse",
        license: r.license,
        width: r.width,
        height: r.height,
      });
      if (out.length >= opts.count) break;
    }
    return out;
  }
}
