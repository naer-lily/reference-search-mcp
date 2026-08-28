/**
 * Shared types for the reference-search MCP server.
 */

/** One image candidate returned by a search provider. */
export interface ImageResult {
  /** Thumbnail URL (used for the composite grid). */
  thumbUrl: string;
  /** Full-size image URL (used by collect). */
  fullUrl: string;
  /** Alt text / title as reported by the source. */
  title: string;
  /** e.g. "pinterest.com". */
  sourceDomain: string;
  /** Provider name that produced this result, e.g. "ddg". */
  provider: string;
  /** License string when the provider reports one (Openverse, Wikimedia...). */
  license?: string;
  width?: number;
  height?: number;
  /** Keyword-group label this result belongs to (multi-aspect searches). */
  group?: string;
}

/** A grid cell: either a candidate or null (unavailable / empty slot). */
export type GridCell = ImageResult | null;

export interface GridSpec {
  columns: number;
  rows: number;
  cellSize: number;
  gap: number;
  /** Total composite width cap in px. */
  maxWidth: number;
}

export const DEFAULT_GRID_SPEC: GridSpec = {
  columns: 6,
  rows: 8,
  cellSize: 256,
  gap: 8,
  maxWidth: 2048,
};

/** One iteration round of a search session. Rounds are labelled a, b, c... */
export interface RoundState {
  /** Round letter: 'a' is the first round. */
  letter: string;
  /** Deduplicated candidates in grid order. Cell i -> id `${letter}${i+1}`. */
  candidates: (ImageResult | null)[];
  /** Path of the rendered composite grid image. */
  gridPath?: string;
  /** IDs chosen by the vision filter, e.g. ["a3", "a17"]. */
  selectedIds: string[];
  /** IDs explicitly rejected in feedback, e.g. ["a3"]. */
  rejectedIds: string[];
  /** keywords actually used for this round. */
  keywordsUsed: string[];
}

export interface SearchSession {
  id: string;
  /** Original natural-language query. */
  query: string;
  /** Filter criteria (style constraints etc.), if any. */
  criteria?: string;
  /** Current keyword set (evolves across rounds). */
  keywords: string[];
  rounds: RoundState[];
  /** pHash -> id of the round that first showed this image. */
  seenHashes: Map<string, string>;
  /** IDs the caller has collected. */
  collectedIds: string[];
  createdAt: number;
  lastUsedAt: number;
}

/** ID helpers: ids are `${roundLetter}${index+1}`, e.g. "b12" = round b, cell 12. */
export function encodeId(roundLetter: string, index: number): string {
  return `${roundLetter}${index + 1}`;
}

export interface ParsedId {
  roundLetter: string;
  /** 0-based cell index. */
  index: number;
}

export function parseId(id: string): ParsedId | null {
  const m = /^([a-z])(\d+)$/.exec(id);
  if (!m) return null;
  const index = Number(m[2]) - 1;
  if (!Number.isInteger(index) || index < 0) return null;
  return { roundLetter: m[1]!, index };
}

/** Output of the vision filter over one round's grid. */
export interface FilterResult {
  selected: string[];
  rejected: string[];
  reasons: Record<string, string>;
  /** Refinement proposals for the next round, if the model offered any. */
  refine?: FeedbackPlan;
  /** Free-text note from the model, if any. */
  note?: string;
}

/** Feedback interpretation from `image_search_iterate`. */
export interface FeedbackPlan {
  addTerms: string[];
  removeTerms: string[];
  /** Optional updated criteria; undefined keeps the previous one. */
  criteria?: string;
  /** Number of extra result pages to fetch for the same keywords. */
  morePages?: number;
}
