import type { Config } from "./config.js";
import { type Llm } from "./llm/pi.js";
import { SessionManager } from "./session/manager.js";
import { searchAll, type SearchProvider } from "./providers/index.js";
import { buildGrid, gridToJpegBase64, type GridCellImage } from "./grid/builder.js";
import { averageHash } from "./grid/phash.js";
import { fetchBuffer } from "./net.js";
import {
  encodeId,
  parseId,
  type FeedbackPlan,
  type GridSpec,
  type ImageResult,
  type SearchSession,
} from "./types.js";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";

/** Error mapped to MCP InvalidParams by the transport layer. */
export class UserError extends Error {}

export interface StartOptions {
  keywords?: string[];
  criteria?: string;
  count?: number;
  safeSearch?: boolean;
  /**
   * Override FILTER_MODE for this call: true = run the server-side vision
   * filter; false = skip it and return all candidates (for multimodal
   * calling models that will look at the grid themselves).
   */
  filter?: boolean;
}

export interface MetadataRow {
  id: string;
  title: string;
  sourceDomain: string;
  license?: string;
  width?: number;
  height?: number;
  provider: string;
  url: string;
}

export interface RoundResult {
  sessionId: string;
  round: string;
  gridPath: string;
  /** True when the server-side vision filter ran; false = all candidates returned. */
  filtered: boolean;
  selectedIds: string[];
  rejectedIds: string[];
  reasons: Record<string, string>;
  refine: FeedbackPlan | null;
  note: string | null;
  metadata: MetadataRow[];
  keywordsUsed: string[];
  warnings: string[];
  dedupeSkipped: number;
}

export interface CollectFile {
  id: string;
  path: string;
  url: string;
  title: string;
  license?: string;
  provider: string;
  width?: number;
  height?: number;
  warning?: string;
}

export interface CollectResult {
  files: CollectFile[];
  failures: { id: string; error: string }[];
  manifestPath: string;
}

export interface StatusResult {
  sessionId: string;
  query: string;
  criteria?: string;
  keywords: string[];
  rounds: {
    round: string;
    selected: string[];
    rejected: string[];
    gridPath?: string;
  }[];
  collectedIds: string[];
}

interface PreparedCell {
  result: ImageResult;
  image: GridCellImage;
  hash: string;
}

export class SearchService {
  private readonly spec: GridSpec;

  constructor(
    private readonly cfg: Config,
    private readonly sessions: SessionManager,
    private readonly llm: Llm | null,
    private readonly providers: SearchProvider[],
  ) {
    this.spec = {
      columns: cfg.gridColumns,
      rows: cfg.gridRows,
      cellSize: cfg.gridCellSize,
      gap: 8,
      maxWidth: cfg.gridMaxWidth,
    };
  }

  // ---------- tools ----------

  async start(query: string, opts: StartOptions = {}): Promise<RoundResult> {
    if (!query || !query.trim()) throw new UserError("query must be a non-empty string");
    const keywords = (opts.keywords ?? []).map((k) => k.trim()).filter(Boolean);
    if (keywords.length === 0) {
      if (!this.llm?.ready) {
        throw new UserError(
          "no LLM is configured (missing pi provider credentials) and no explicit keywords were given; pass keywords explicitly",
        );
      }
      const parsed = await this.llm.parseKeywords(query, opts.criteria);
      if (!parsed || parsed.length === 0) {
        throw new UserError("LLM produced no usable keywords; pass keywords explicitly");
      }
      keywords.push(...parsed);
    }
    const session = this.sessions.create(query, keywords, opts.criteria);
    return this.runRound(session, keywords, 0, opts, this.shouldFilter(opts));
  }

  async iterate(sessionId: string, feedback: string, opts: StartOptions = {}): Promise<RoundResult> {
    const session = this.getSession(sessionId);
    const explicit = (opts.keywords ?? []).map((k) => k.trim()).filter(Boolean);
    let keywords: string[];
    let page: number;
    let plan: FeedbackPlan | null = null;
    const warnings: string[] = [];

    if (explicit.length > 0) {
      keywords = explicit;
      session.keywords = keywords;
      page = session.rounds.length; // next page of results
    } else if (this.llm?.ready) {
      plan = await this.llm.interpretFeedback({
        query: session.query,
        criteria: session.criteria,
        currentKeywords: session.keywords,
        roundsSummary: summarizeRounds(session),
        feedback,
      });
      if (!plan || (plan.addTerms.length === 0 && plan.removeTerms.length === 0 && !plan.criteria && !plan.morePages)) {
        warnings.push("LLM proposed no keyword changes; fetching the next page with current keywords");
        keywords = session.keywords;
        page = session.rounds.length;
      } else {
        keywords = mergeKeywords(session.keywords, plan);
        session.keywords = keywords;
        if (plan.criteria) session.criteria = plan.criteria;
        page = 0;
      }
    } else {
      throw new UserError("no LLM is configured and no explicit keywords were given");
    }

    const result = await this.runRound(session, keywords, page, opts, this.shouldFilter(opts));
    result.refine = plan;
    result.warnings.push(...warnings);
    return result;
  }

  async collect(sessionId: string, ids: string[]): Promise<CollectResult> {
    const session = this.getSession(sessionId);
    const dir = path.join(this.cfg.outDir, session.id);
    mkdirSync(dir, { recursive: true });
    const files: CollectFile[] = [];
    const failures: { id: string; error: string }[] = [];

    for (const id of ids) {
      const parsed = parseId(id);
      const round = parsed ? session.rounds.find((r) => r.letter === parsed.roundLetter) : undefined;
      const cand = parsed && round ? round.candidates[parsed.index] : undefined;
      if (!cand) {
        failures.push({ id, error: "unknown id (wrong session, round, or index)" });
        continue;
      }
      try {
        const referer = cand.sourceDomain ? `https://${cand.sourceDomain}/` : undefined;
        const fr = await fetchBuffer(cand.fullUrl, {
          timeoutMs: this.cfg.httpTimeoutMs,
          maxBytes: this.cfg.maxFullBytes,
          expectImage: true,
          retries: 2,
          referer,
        });
        const ext = extFor(fr.contentType, cand.fullUrl);
        const filePath = path.join(dir, `${id}.${ext}`);
        writeFileSync(filePath, fr.buffer);
        let width: number | undefined;
        let height: number | undefined;
        let warning: string | undefined;
        try {
          const meta = await sharp(filePath).metadata();
          width = meta.width;
          height = meta.height;
          if (!width || !height) warning = "image metadata could not be read";
        } catch {
          warning = "file saved but could not be decoded as an image";
        }
        files.push({
          id,
          path: filePath,
          url: cand.fullUrl,
          title: cand.title,
          license: cand.license,
          provider: cand.provider,
          width,
          height,
          warning,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({ id, error: msg });
      }
    }

    const manifest = { sessionId, query: session.query, files: files.map((f) => ({ ...f })) };
    const manifestPath = path.join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    session.collectedIds.push(...files.map((f) => f.id));
    return { files, failures, manifestPath };
  }

  status(sessionId: string): StatusResult {
    const session = this.getSession(sessionId);
    return {
      sessionId,
      query: session.query,
      criteria: session.criteria,
      keywords: session.keywords,
      rounds: session.rounds.map((r) => ({
        round: r.letter,
        selected: r.selectedIds,
        rejected: r.rejectedIds,
        gridPath: r.gridPath,
      })),
      collectedIds: session.collectedIds,
    };
  }

  // ---------- internals ----------

  private getSession(sessionId: string): SearchSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new UserError(`unknown session "${sessionId}" (expired or never created)`);
    return s;
  }

  /**
   * Whether the server-side vision filter should run for this call.
   * Explicit opts.filter wins; otherwise FILTER_MODE decides; "auto" runs the
   * filter only when a vision model is actually configured.
   */
  private shouldFilter(opts: StartOptions): boolean {
    if (opts.filter === false) return false;
    if (opts.filter === true) return this.llm?.ready === true;
    if (this.cfg.filterMode === "client") return false;
    return this.llm?.ready === true;
  }

  private async runRound(
    session: SearchSession,
    keywords: string[],
    page: number,
    opts: StartOptions,
    filter: boolean,
  ): Promise<RoundResult> {
    const max = this.spec.columns * this.spec.rows;
    const warnings: string[] = [];
    const letter = this.sessions.nextLetter(session);

    const { results, errors } = await searchAll(this.providers, keywords, {
      count: Math.min(opts.count ?? max, max),
      page,
      safeSearch: opts.safeSearch ?? this.cfg.safeSearch,
      timeoutMs: this.cfg.httpTimeoutMs,
    });
    warnings.push(...errors);

    const { cells, skipped } = await this.prepareCells(results, session, letter, max);

    const gridPath = this.sessions.gridPath(session, letter);
    await buildGrid({
      spec: this.spec,
      roundLabel: letter,
      outPath: gridPath,
      cells: cells.map((c) => c?.image ?? null),
    });

    const validIds = cells.map((_, i) => encodeId(letter, i));
    const metadataTable = buildMetadataTable(cells, letter);
    let filtered = false;
    let selectedIds: string[] = [];
    let rejectedIds: string[] = [];
    const reasons: Record<string, string> = {};
    let refine: FeedbackPlan | null = null;
    let note: string | null = null;

    if (filter && this.llm?.ready) {
      filtered = true;
      const img = await gridToJpegBase64(gridPath, 1536, 85);
      const fr = await this.llm.filterGrid({
        query: session.query,
        criteria: session.criteria,
        keywords,
        roundLetter: letter,
        validIds,
        metadataTable,
        image: img,
      });
      if (fr) {
        selectedIds = fr.selected;
        rejectedIds = fr.rejected;
        Object.assign(reasons, fr.reasons);
        if (fr.refine) {
          refine = fr.refine;
          session.keywords = mergeKeywords(session.keywords, fr.refine);
          if (fr.refine.criteria) session.criteria = fr.refine.criteria;
        }
        if (fr.note) note = fr.note;
      } else {
        warnings.push("LLM filter failed; all candidates returned unselected");
        selectedIds = validIds;
      }
    } else {
      if (filter && !this.llm?.ready) {
        warnings.push("vision filter requested but no LLM is configured; returning all candidates");
      }
      selectedIds = validIds;
    }

    session.rounds.push({
      letter,
      candidates: cells.map((c) => c?.result ?? null),
      gridPath,
      selectedIds,
      rejectedIds,
      keywordsUsed: keywords,
    });

    return {
      sessionId: session.id,
      round: letter,
      gridPath,
      filtered,
      selectedIds,
      rejectedIds,
      reasons,
      refine,
      note,
      metadata: cells.map((c, i) => (c ? toMetadataRow(encodeId(letter, i), c.result) : null)).filter((r): r is MetadataRow => r !== null),
      keywordsUsed: keywords,
      warnings,
      dedupeSkipped: skipped,
    };
  }

  /**
   * Fetch thumbnails (bounded concurrency), compute hashes, dedupe against
   * everything shown in previous rounds (exact aHash match), keep order.
   */
  private async prepareCells(
    results: ImageResult[],
    session: SearchSession,
    letter: string,
    max: number,
  ): Promise<{ cells: (PreparedCell | null)[]; skipped: number }> {
    const cells: (PreparedCell | null)[] = [];
    let skipped = 0;
    const limited = results.slice(0, max * 3); // head room for dedupe

    const fetched = await mapLimit(limited, 8, async (r) => {
      let buffer: Buffer | null = null;
      try {
        const fr = await fetchBuffer(r.thumbUrl, {
          timeoutMs: this.cfg.httpTimeoutMs,
          maxBytes: this.cfg.maxThumbBytes,
          expectImage: true,
          retries: 1,
        });
        buffer = fr.buffer;
      } catch {
        buffer = null; // unavailable cell
      }
      let hash = "";
      if (buffer) {
        try {
          hash = await averageHash(buffer);
        } catch {
          hash = "";
        }
      }
      return { result: r, buffer, hash };
    });

    for (const f of fetched) {
      if (cells.length >= max) break;
      if (f.hash) {
        const id = encodeId(letter, cells.length);
        if (session.seenHashes.has(f.hash)) {
          skipped++;
          continue;
        }
        session.seenHashes.set(f.hash, id);
      }
      cells.push(f.buffer ? { result: f.result, image: { buffer: f.buffer }, hash: f.hash } : null);
    }
    return { cells, skipped };
  }
}

// ---------- helpers ----------

function mergeKeywords(current: string[], plan: FeedbackPlan): string[] {
  const remove = new Set(plan.removeTerms.map((t) => t.toLowerCase()));
  const kept = current.filter((k) => !remove.has(k.toLowerCase()));
  const out = [...kept];
  for (const t of plan.addTerms) {
    const key = t.toLowerCase();
    if (!out.some((k) => k.toLowerCase() === key)) out.push(t);
  }
  return out;
}

function summarizeRounds(session: SearchSession): string {
  return session.rounds
    .map((r) => `${r.letter}: ${r.selectedIds.length} selected, ${r.rejectedIds.length} rejected (keywords: ${r.keywordsUsed.join(", ")})`)
    .join("\n");
}

function sanitize(s: string, max = 80): string {
  return s.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

function toMetadataRow(id: string, r: ImageResult): MetadataRow {
  return {
    id,
    title: sanitize(r.title),
    sourceDomain: r.sourceDomain,
    license: r.license,
    width: r.width,
    height: r.height,
    provider: r.provider,
    url: r.fullUrl,
  };
}

function buildMetadataTable(cells: (PreparedCell | null)[], letter: string): string {
  const rows: string[] = [];
  cells.forEach((c, i) => {
    if (!c) {
      rows.push(`${encodeId(letter, i)} | unavailable`);
      return;
    }
    const r = c.result;
    rows.push(
      `${encodeId(letter, i)} | ${sanitize(r.title, 60)} | ${r.sourceDomain} | ${r.license ?? "-"} | ` +
        `${r.width && r.height ? `${r.width}x${r.height}` : "-"}`,
    );
  });
  return rows.join("\n");
}

function extFor(contentType: string, url: string): string {
  const m = /image\/(\w+)/.exec(contentType);
  if (m) {
    const ext = m[1]!.toLowerCase();
    if (ext === "jpeg") return "jpg";
    if (["png", "gif", "webp", "avif", "bmp", "svg+xml", "svg"].includes(ext)) return ext === "svg+xml" ? "svg" : ext;
  }
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname).slice(1).toLowerCase();
    if (/^[a-z0-9]{2,5}$/.test(ext)) return ext;
  } catch {
    /* ignore */
  }
  return "img";
}

/** Run async fn over items with bounded concurrency, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
