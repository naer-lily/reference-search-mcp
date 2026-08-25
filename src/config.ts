import "dotenv/config";
import { tmpdir } from "node:os";
import path from "node:path";

export interface CustomProviderConfig {
  id: string;
  /** pi-ai api id, e.g. "openai-completions". */
  api: string;
  baseUrl: string;
  /** Name of the env var holding the API key. */
  apiKeyEnv: string;
  /** Model ids offered by this endpoint, e.g. ["qwen-vl-max"]. */
  models: string[];
}

export interface Config {
  providers: string[];
  safeSearch: boolean;
  gridColumns: number;
  gridRows: number;
  gridCellSize: number;
  gridMaxWidth: number;
  sessionTtlMs: number;
  dataDir: string;
  outDir: string;
  httpTimeoutMs: number;
  maxThumbBytes: number;
  maxFullBytes: number;
  /** "provider/model" strings, e.g. "deepseek/deepseek-chat". */
  piTextModel?: string;
  piVisionModel?: string;
  piThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Max tool-loop turns for LLM calls inside the server. */
  llmMaxTurns: number;
  /**
   * Who runs the vision filter over the grid:
   * - "auto"   (default): the server filters when a vision model is configured,
   *   otherwise returns all candidates (degraded).
   * - "server": always filter server-side (for text-only calling models).
   * - "client": never filter server-side; the calling model looks at the grid
   *   itself and picks ids (for multimodal calling models). Saves one vision call.
   */
  filterMode: "auto" | "server" | "client";
  openverseToken?: string;
  serperApiKey?: string;
  customProvider?: CustomProviderConfig;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function str(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = str(env, "DATA_DIR") ?? path.join(tmpdir(), "reference-search-mcp", "data");
  const outDir = str(env, "OUT_DIR") ?? path.join(process.cwd(), "out");

  const customProviderApi = str(env, "PI_CUSTOM_PROVIDER_API");
  const customProviderBase = str(env, "PI_CUSTOM_PROVIDER_BASE_URL");
  const customProviderModels = str(env, "PI_CUSTOM_PROVIDER_MODELS");
  let customProvider: CustomProviderConfig | undefined;
  if (customProviderApi && customProviderBase && customProviderModels) {
    customProvider = {
      id: str(env, "PI_CUSTOM_PROVIDER_ID") ?? "custom",
      api: customProviderApi,
      baseUrl: customProviderBase,
      apiKeyEnv: str(env, "PI_CUSTOM_PROVIDER_API_KEY_ENV") ?? "PI_CUSTOM_PROVIDER_API_KEY",
      models: customProviderModels.split(",").map((s) => s.trim()).filter(Boolean),
    };
  }

  return {
    providers: (str(env, "PROVIDERS") ?? "ddg,bing,wikimedia").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    safeSearch: bool(env, "SAFE_SEARCH", true),
    gridColumns: num(env, "GRID_COLUMNS", 6),
    gridRows: num(env, "GRID_ROWS", 8),
    gridCellSize: num(env, "GRID_CELL_SIZE", 256),
    gridMaxWidth: num(env, "GRID_MAX_WIDTH", 2048),
    sessionTtlMs: num(env, "SESSION_TTL_MINUTES", 120) * 60_000,
    dataDir,
    outDir,
    httpTimeoutMs: num(env, "HTTP_TIMEOUT_MS", 15_000),
    maxThumbBytes: num(env, "MAX_THUMB_BYTES", 2 * 1024 * 1024),
    maxFullBytes: num(env, "MAX_FULL_BYTES", 20 * 1024 * 1024),
    piTextModel: str(env, "PI_TEXT_MODEL"),
    piVisionModel: str(env, "PI_VISION_MODEL"),
    piThinking: (str(env, "PI_THINKING") as Config["piThinking"]) ?? undefined,
    llmMaxTurns: num(env, "LLM_MAX_TURNS", 3),
    filterMode: (str(env, "FILTER_MODE") as Config["filterMode"]) ?? "auto",
    openverseToken: str(env, "OPENVERSE_TOKEN"),
    serperApiKey: str(env, "SERPER_API_KEY"),
    customProvider,
  };
}
