/**
 * HTTP fetch helpers: bounded retries, timeouts, size limits, UA.
 */

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  maxBytes?: number;
  retries?: number;
  /** Reject when the response is not an image/* content type. */
  expectImage?: boolean;
  referer?: string;
  signal?: AbortSignal;
}

export interface FetchResult {
  buffer: Buffer;
  contentType: string;
  status: number;
  finalUrl: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchBuffer(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const retries = opts.retries ?? 2;
  const expectImage = opts.expectImage ?? false;
  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_UA,
    Accept: "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8",
    ...opts.headers,
    ...(opts.referer ? { Referer: opts.referer } : {}),
  };

  let lastErr: Error = new HttpError("no attempt made");
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(300 * 2 ** attempt + Math.random() * 200);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new HttpError(`timeout after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => controller.abort(opts.signal?.reason ?? new Error("aborted"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
      if (!res.ok) {
        const e = new HttpError(`HTTP ${res.status} for ${url}`, res.status);
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retries) {
          lastErr = e;
          continue;
        }
        throw e;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (expectImage && !contentType.startsWith("image/")) {
        throw new HttpError(`not an image (${contentType || "no content-type"}) for ${url}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > maxBytes) throw new HttpError(`payload ${buffer.length}B exceeds maxBytes ${maxBytes}`);
      if (expectImage && buffer.length < 32) throw new HttpError("image payload too small");
      return { buffer, contentType, status: res.status, finalUrl: res.url };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      lastErr = err;
      if (err instanceof HttpError && err.status !== undefined && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw err;
      }
      if (attempt === retries) throw lastErr;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr;
}

/** Extract the hostname of a URL, minus www. */
export function parseDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
