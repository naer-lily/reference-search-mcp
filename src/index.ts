#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { PiLlm } from "./llm/pi.js";
import { SessionManager } from "./session/manager.js";
import { createProviders } from "./providers/index.js";
import { SearchService } from "./service.js";
import { serveStdio } from "./mcp/server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(cfg.dataDir, { recursive: true });
  mkdirSync(cfg.outDir, { recursive: true });

  let llm: PiLlm | null = null;
  try {
    llm = await PiLlm.create(cfg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[reference-search] pi LLM init failed (${msg}); running in degraded mode (explicit keywords only)\n`);
  }
  if (llm && !llm.ready) {
    process.stderr.write(
      "[reference-search] no pi provider credentials found; running in degraded mode (explicit keywords only)\n",
    );
  }

  const sessions = new SessionManager(cfg.dataDir, cfg.sessionTtlMs);
  const providers = createProviders(cfg);
  if (providers.length === 0) {
    process.stderr.write("[reference-search] WARNING: no image search providers enabled\n");
  }
  const service = new SearchService(cfg, sessions, llm, providers);

  const timer = setInterval(() => sessions.cleanup(), 10 * 60_000);
  timer.unref();

  await serveStdio(service);
}

main().catch((e) => {
  process.stderr.write(`[reference-search] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
