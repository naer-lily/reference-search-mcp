import type { ImageResult } from "../types.js";

export interface ProviderSearchOptions {
  /** Max results per provider. */
  count: number;
  /** 0-based result page. */
  page?: number;
  safeSearch: boolean;
  timeoutMs: number;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider?: string,
  ) {
    super(message);
  }
}

export interface SearchProvider {
  readonly name: string;
  search(keywords: string[], opts: ProviderSearchOptions): Promise<ImageResult[]>;
}

export function buildQuery(keywords: string[]): string {
  return keywords.join(" ");
}

export interface SearchAllResult {
  results: ImageResult[];
  /** Provider-level failures, one entry per failed provider. */
  errors: string[];
}

/** Run all providers in parallel; a failing provider is isolated. */
export async function searchAll(
  providers: SearchProvider[],
  keywords: string[],
  opts: ProviderSearchOptions,
): Promise<SearchAllResult> {
  const outcomes = await Promise.allSettled(providers.map((p) => p.search(keywords, opts)));
  const results: ImageResult[] = [];
  const errors: string[] = [];
  outcomes.forEach((o, i) => {
    if (o.status === "fulfilled") {
      results.push(...o.value);
    } else {
      const name = providers[i]?.name ?? "?";
      const msg = o.reason instanceof Error ? o.reason.message : String(o.reason);
      errors.push(`[${name}] ${msg}`);
    }
  });
  return { results, errors };
}
