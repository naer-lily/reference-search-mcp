/**
 * Diagnosis: run the REAL parseKeywords path (tool loop, nudging, no JSON
 * fallback) against the configured text model.
 *
 *   npx tsx scripts/debug-pi.ts "M1911各角度图片，包含正面侧面正侧面"
 */
import { loadConfig } from "../src/config.js";
import { PiLlm } from "../src/llm/pi.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
process.env.DATA_DIR ??= path.join(root, "data");
process.env.OUT_DIR ??= path.join(root, "out");

async function main() {
  const query = process.argv[2] ?? "M1911各角度图片，要足够全面，包含适用于绘画的各个角度，包括正面，侧面，正侧面";
  const cfg = loadConfig();
  mkdirSync(cfg.dataDir, { recursive: true });
  const llm = await PiLlm.create(cfg);
  if (!llm.ready) {
    console.error("LLM not ready (no credentials?)");
    process.exit(1);
  }
  console.log("query:", query);
  const t0 = Date.now();
  const plan = await llm.parseKeywords(query, "适合绘画参考，清晰，光照均匀");
  console.log(`parsed in ${Date.now() - t0}ms`);
  console.log(JSON.stringify(plan, null, 2));
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
