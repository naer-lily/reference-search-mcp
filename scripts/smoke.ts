/**
 * E2E smoke test (no MCP transport): real providers + optional real LLM.
 *
 *   npx tsx scripts/smoke.ts --query "space nebula illustration" \
 *     --keywords "nebula,space art" --criteria "dark, no text" \
 *     --collect a1,a2 --iterate "more like a1, less photos"
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { PiLlm } from "../src/llm/pi.js";
import { SessionManager } from "../src/session/manager.js";
import { createProviders } from "../src/providers/index.js";
import { SearchService } from "../src/service.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const query = arg("query");
  if (!query) {
    console.error("usage: --query <text> [--keywords a,b] [--criteria c] [--iterate feedback] [--collect a1,b2]");
    process.exit(2);
  }
  process.env.DATA_DIR ??= path.join(root, "data");
  process.env.OUT_DIR ??= path.join(root, "out");
  const cfg = loadConfig();
  mkdirSync(cfg.dataDir, { recursive: true });
  mkdirSync(cfg.outDir, { recursive: true });

  let llm: PiLlm | null = null;
  try {
    llm = await PiLlm.create(cfg);
  } catch (e) {
    console.warn(`[smoke] LLM init failed: ${e instanceof Error ? e.message : e} (degraded mode)`);
  }
  if (llm && !llm.ready) console.warn("[smoke] no pi provider credentials; degraded mode (pass --keywords)");

  const sessions = new SessionManager(cfg.dataDir, cfg.sessionTtlMs);
  const service = new SearchService(cfg, sessions, llm, createProviders(cfg));
  const t0 = Date.now();

  const r1 = await service.start(query, {
    keywords: arg("keywords")?.split(",").map((s) => s.trim()).filter(Boolean),
    criteria: arg("criteria"),
    filter: process.argv.includes("--no-filter") ? false : undefined,
  });
  console.log(`[smoke] round ${r1.round} in ${Date.now() - t0}ms; selected ${r1.selectedIds.length}/${r1.metadata.length}; skipped dups ${r1.dedupeSkipped}`);
  console.log(JSON.stringify(r1, null, 2));

  const iterateFeedback = arg("iterate");
  if (iterateFeedback) {
    const r2 = await service.iterate(
      r1.sessionId,
      iterateFeedback,
      llm?.ready ? {} : { keywords: r1.keywordsUsed }, // degraded mode: explicit keywords
    );
    console.log(`[smoke] round ${r2.round} selected ${r2.selectedIds.length}/${r2.metadata.length}`);
    console.log(JSON.stringify(r2, null, 2));
  }

  const collectArg = arg("collect");
  if (collectArg) {
    const ids = collectArg.split(",").map((s) => s.trim()).filter(Boolean);
    const c = await service.collect(r1.sessionId, ids);
    console.log(`[smoke] collected ${c.files.length} files, ${c.failures.length} failures`);
    console.log(JSON.stringify({ files: c.files, failures: c.failures, manifestPath: c.manifestPath }, null, 2));
  }
}

main().catch((e) => {
  console.error("[smoke] failed:", e);
  process.exit(1);
});
