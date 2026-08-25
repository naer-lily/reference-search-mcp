import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const cfg = loadConfig({});
    expect(cfg.providers).toEqual(["ddg", "bing", "wikimedia"]);
    expect(cfg.safeSearch).toBe(true);
    expect(cfg.gridColumns).toBe(6);
    expect(cfg.gridRows).toBe(8);
    expect(cfg.sessionTtlMs).toBe(120 * 60_000);
    expect(cfg.customProvider).toBeUndefined();
  });

  it("parses env overrides", () => {
    const cfg = loadConfig({
      PROVIDERS: " ddg , serper ",
      SAFE_SEARCH: "false",
      GRID_COLUMNS: "4",
      GRID_ROWS: "5",
      GRID_CELL_SIZE: "300",
      SESSION_TTL_MINUTES: "10",
      SERPER_API_KEY: "sk-test",
      PI_TEXT_MODEL: "deepseek/deepseek-chat",
      PI_VISION_MODEL: "anthropic/claude-sonnet-4-5",
      PI_THINKING: "high",
      FILTER_MODE: "client",
    });
    expect(cfg.providers).toEqual(["ddg", "serper"]);
    expect(cfg.safeSearch).toBe(false);
    expect(cfg.gridColumns).toBe(4);
    expect(cfg.gridRows).toBe(5);
    expect(cfg.gridCellSize).toBe(300);
    expect(cfg.sessionTtlMs).toBe(10 * 60_000);
    expect(cfg.serperApiKey).toBe("sk-test");
    expect(cfg.piTextModel).toBe("deepseek/deepseek-chat");
    expect(cfg.piThinking).toBe("high");
    expect(cfg.filterMode).toBe("client");
  });

  it("builds custom provider config from env", () => {
    const cfg = loadConfig({
      PI_CUSTOM_PROVIDER_API: "openai-completions",
      PI_CUSTOM_PROVIDER_BASE_URL: "http://localhost:8000/v1",
      PI_CUSTOM_PROVIDER_MODELS: "qwen-vl-max, qwen-turbo",
      PI_CUSTOM_PROVIDER_ID: "myqwen",
      PI_CUSTOM_PROVIDER_API_KEY_ENV: "MY_KEY",
    });
    expect(cfg.customProvider).toEqual({
      id: "myqwen",
      api: "openai-completions",
      baseUrl: "http://localhost:8000/v1",
      apiKeyEnv: "MY_KEY",
      models: ["qwen-vl-max", "qwen-turbo"],
    });
  });
});
