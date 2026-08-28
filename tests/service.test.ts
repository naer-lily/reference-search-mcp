import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session/manager.js";
import { SearchService, UserError } from "../src/service.js";
import { type Llm, type FilterGridInput, type FeedbackInput, type KeywordPlan } from "../src/llm/pi.js";
import { type ProviderSearchOptions, type SearchProvider } from "../src/providers/base.js";
import type { FeedbackPlan, FilterResult, ImageResult } from "../src/types.js";

/** Distinct patterned PNG data URL per seed (aHash is degenerate on uniform images). */
async function patternDataUrl(seed: number): Promise<string> {
  const w = 4;
  const h = 4;
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      // structural (multiplicative) variation per seed — additive shifts are
      // invisible to average hashing
      data[i] = (x * (37 + seed * 11) + seed * 17) % 256;
      data[i + 1] = (y * (53 + seed * 13) + seed * 29) % 256;
      data[i + 2] = (x * y * (11 + seed * 7) + seed * 43) % 256;
    }
  }
  const png = await sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function result(n: number): Promise<ImageResult> {
  const url = await patternDataUrl(n);
  return {
    thumbUrl: url,
    fullUrl: url,
    title: `image ${n}`,
    sourceDomain: "fake.example",
    provider: "fake",
    width: 1,
    height: 1,
  };
}

class FakeProvider implements SearchProvider {
  readonly name = "fake";
  searchCalls: string[][] = [];
  constructor(private readonly items: ImageResult[]) {}
  async search(keywords: string[], _o: ProviderSearchOptions): Promise<ImageResult[]> {
    this.searchCalls.push(keywords);
    return this.items;
  }
}

class FakeLlm implements Llm {
  ready = true;
  parseCalls = 0;
  filterCalls: FilterGridInput[] = [];
  constructor(
    private readonly plan: KeywordPlan = { terms: ["parsed-a", "parsed-b"] },
    private readonly filter: (input: FilterGridInput) => FilterResult = () => ({ selected: [], rejected: [], reasons: {} }),
  ) {}
  async parseKeywords(_q: string, _c?: string): Promise<KeywordPlan | null> {
    this.parseCalls++;
    return this.plan;
  }
  async interpretFeedback(_i: FeedbackInput): Promise<FeedbackPlan | null> {
    return { addTerms: ["more-x"], removeTerms: [] };
  }
  async filterGrid(input: FilterGridInput): Promise<FilterResult> {
    this.filterCalls.push(input);
    return this.filter(input);
  }
}

function setup(llm: Llm | null, provider: SearchProvider) {
  const cfg = loadConfig({
    DATA_DIR: mkdtempSync(path.join(tmpdir(), "rs-data-")),
    OUT_DIR: mkdtempSync(path.join(tmpdir(), "rs-out-")),
    PROVIDERS: "fake",
    GRID_COLUMNS: "2",
    GRID_ROWS: "2",
    SAFE_SEARCH: "true",
  });
  const sessions = new SessionManager(cfg.dataDir, 60_000);
  return { cfg, service: new SearchService(cfg, sessions, llm, [provider]) };
}

describe("SearchService", () => {
  it("start parses keywords via LLM when none given", async () => {
    const llm = new FakeLlm();
    const { service } = setup(llm, new FakeProvider(await Promise.all([1, 2, 3].map(result))));
    const r = await service.start("find cats", {});
    expect(llm.parseCalls).toBe(1);
    expect(r.round).toBe("a");
    expect(r.keywordsUsed).toEqual(["parsed-a", "parsed-b"]);
    expect(r.metadata).toHaveLength(3); // grid capacity 2x2=4, 3 results available
    expect(existsSync(r.gridPath)).toBe(true);
    expect(r.selectedIds).toEqual([]); // fake filter selected nothing
  });

  it("start requires explicit keywords when LLM is unavailable", async () => {
    const { service } = setup(null, new FakeProvider([await result(1)]));
    await expect(service.start("find cats", {})).rejects.toThrow(UserError);
    const r = await service.start("find cats", { keywords: ["cat"] });
    expect(r.round).toBe("a");
    expect(r.keywordsUsed).toEqual(["cat"]);
    // degraded: all candidates returned unselected
    expect(r.selectedIds).toEqual(["a1"]);
  });

  it("iterate runs a second round with dedupe across rounds", async () => {
    const llm = new FakeLlm();
    const { service } = setup(llm, new FakeProvider(await Promise.all([1, 2, 3, 4].map(result))));
    const r1 = await service.start("cats", { keywords: ["cat"] });
    expect(r1.round).toBe("a");
    const r2 = await service.iterate(r1.sessionId, "more like a1", {});
    expect(r2.round).toBe("b");
    // same 4 results are all duplicates of round a -> no new cells
    expect(r2.dedupeSkipped).toBeGreaterThan(0);
    expect(r2.metadata).toHaveLength(0);
    expect(r2.keywordsUsed).toEqual(["cat", "more-x"]); // fake interpretFeedback adds more-x
  });

  it("iterate rejects unknown sessions", async () => {
    const llm = new FakeLlm();
    const { service } = setup(llm, new FakeProvider([]));
    await expect(service.iterate("nope", "x", { keywords: ["k"] })).rejects.toThrow(UserError);
  });

  it("collect downloads full images by id and writes a manifest", async () => {
    const llm = new FakeLlm();
    const { service } = setup(llm, new FakeProvider([await result(1)]));
    const r1 = await service.start("cats", { keywords: ["cat"] });
    const collected = await service.collect(r1.sessionId, ["a1"]);
    expect(collected.failures).toHaveLength(0);
    expect(collected.files).toHaveLength(1);
    expect(collected.files[0].id).toBe("a1");
    expect(existsSync(collected.files[0].path)).toBe(true);
    const meta = await sharp(collected.files[0].path).metadata();
    expect(meta.format).toBe("png");
    const manifest = JSON.parse(readFileSync(collected.manifestPath, "utf8"));
    expect(manifest.files[0].id).toBe("a1");
  });

  it("collect reports unknown ids as failures", async () => {
    const llm = new FakeLlm();
    const { service } = setup(llm, new FakeProvider([await result(1)]));
    const r1 = await service.start("cats", { keywords: ["cat"] });
    const collected = await service.collect(r1.sessionId, ["zz", "b1"]);
    expect(collected.failures).toHaveLength(2);
    expect(collected.files).toHaveLength(0);
  });

  it("vision filter receives valid ids, grid image, and metadata table", async () => {
    let seen: FilterGridInput | undefined;
    const llm = new FakeLlm({ terms: ["k"] }, (input) => {
      seen = input;
      return { selected: [input.validIds[0]!], rejected: [], reasons: { [input.validIds[0]!]: "best" } };
    });
    const { service } = setup(llm, new FakeProvider(await Promise.all([1, 2].map(result))));
    const r = await service.start("cats", {});
    expect(seen).toBeDefined();
    expect(seen!.validIds).toEqual(["a1", "a2"]);
    expect(seen!.metadataTable).toContain("a1 | image 1 | fake.example | - | 1x1");
    expect(seen!.image.mimeType).toBe("image/jpeg");
    expect(r.selectedIds).toEqual(["a1"]);
    expect(r.reasons.a1).toBe("best");
    expect(r.filtered).toBe(true);
  });

  it("filter:false skips the server vision filter and returns all candidates", async () => {
    const llm = new FakeLlm();
    const { service } = setup(llm, new FakeProvider(await Promise.all([1, 2].map(result))));
    const r = await service.start("cats", { keywords: ["cat"], filter: false });
    expect(llm.filterCalls).toHaveLength(0); // vision filter never ran
    expect(r.filtered).toBe(false);
    expect(r.selectedIds).toEqual(["a1", "a2"]); // all candidates
  });

  it("FILTER_MODE=client disables filtering even when a vision model exists", async () => {
    const llm = new FakeLlm();
    const cfg = loadConfig({
      DATA_DIR: mkdtempSync(path.join(tmpdir(), "rs-data-")),
      OUT_DIR: mkdtempSync(path.join(tmpdir(), "rs-out-")),
      PROVIDERS: "fake",
      GRID_COLUMNS: "2",
      GRID_ROWS: "2",
      FILTER_MODE: "client",
    });
    const sessions = new SessionManager(cfg.dataDir, 60_000);
    const service = new SearchService(cfg, sessions, llm, [new FakeProvider(await Promise.all([1, 2].map(result)))]);
    const r = await service.start("cats", { keywords: ["cat"] });
    expect(llm.filterCalls).toHaveLength(0);
    expect(r.filtered).toBe(false);
    expect(r.selectedIds).toEqual(["a1", "a2"]);
  });

  it("multi-aspect keyword groups are searched in parallel and tagged in metadata", async () => {
    const llm = new FakeLlm({
      terms: ["M1911 pistol"],
      groups: [
        { label: "正面", terms: ["M1911 front view"] },
        { label: "侧面", terms: ["M1911 side view"] },
      ],
    });
    const provider = new FakeProvider([await result(1)]);
    const { service } = setup(llm, provider);
    const r = await service.start("M1911 各角度", {});
    // one search per group (main terms not searched when groups exist)
    expect(provider.searchCalls).toHaveLength(2);
    expect(provider.searchCalls[0]).toEqual(["M1911 front view"]);
    expect(provider.searchCalls[1]).toEqual(["M1911 side view"]);
    // results tagged with group label
    expect(r.metadata[0].group).toBe("正面");
    expect(r.keywordsUsed).toEqual(["M1911 pistol"]);
  });
});
