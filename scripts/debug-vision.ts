import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createProvider, envApiKeyAuth, lazyApi } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import sharp from "sharp";
import { loadConfig } from "../src/config.js";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const cfg = loadConfig(); // triggers dotenv

const models = builtinModels();
if (cfg.customProvider) {
  const cp = cfg.customProvider;
  const api = lazyApi(() => import(`@earendil-works/pi-ai/api/${cp.api}`));
  models.setProvider(
    createProvider({
      id: cp.id,
      name: cp.id,
      baseUrl: cp.baseUrl,
      auth: { apiKey: envApiKeyAuth(cp.id, [cp.apiKeyEnv]) },
      api,
      models: cp.models.map((id) => ({
        id,
        name: id,
        api: cp.api as never,
        provider: cp.id,
        baseUrl: cp.baseUrl,
        reasoning: false,
        input: ["text", "image"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      })),
    }),
  );
}

const visionModel = models.getModel(cfg.customProvider!.id, cfg.customProvider!.models[0]!);
if (!visionModel) {
  console.error("vision model not found");
  process.exit(1);
}

// use the most recent grid from the data dir
const sessionsDir = path.join(cfg.dataDir, "sessions");
const grids = readdirSync(sessionsDir, { recursive: true })
  .filter((f) => String(f).endsWith(".png"))
  .map((f) => path.join(sessionsDir, String(f)))
  .sort((a, b) => b.localeCompare(a));
const gridPath = grids[0];
if (!gridPath) {
  console.error("no grid found in", sessionsDir);
  process.exit(1);
}
console.log("grid:", gridPath);
const jpeg = await sharp(gridPath).resize({ width: 1536 }).jpeg({ quality: 85 }).toBuffer();
const data = jpeg.toString("base64");

const selectTool = {
  name: "select_images",
  description: "Mark grid cells to keep. Only valid cell ids may be used.",
  parameters: Type.Object(
    { ids: Type.Array(Type.String({ description: "valid cell ids, e.g. a3" })), note: Type.Optional(Type.String()) },
    { additionalProperties: false },
  ),
};
const rejectTool = {
  name: "reject_images",
  description: "Mark grid cells as clearly irrelevant.",
  parameters: Type.Object({ ids: Type.Array(Type.String()) }, { additionalProperties: false }),
};
const refineTool = {
  name: "refine_search",
  description: "Propose keyword changes for the next search round.",
  parameters: Type.Object(
    {
      add_terms: Type.Array(Type.String()),
      remove_terms: Type.Array(Type.String()),
      criteria: Type.Optional(Type.String()),
      more_pages: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
};

const context = {
  systemPrompt:
    "You are an expert image curator. You are shown a numbered contact sheet of search results (round A, cells a1..a6) plus a metadata table. Pick the images that best match the query and criteria: relevant, high quality, style-consistent, no watermarks or text overlays when avoidable. Use the tools:\n- select_images: keep these cells.\n- reject_images: mark clearly irrelevant cells (optional).\n- refine_search: propose next-round keyword changes (optional).\nOnly valid cell ids may be used. You may call tools several times.",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Query: aurora borealis wallpaper\nCriteria: dark sky, vivid aurora, no watermark\nKeywords: aurora, wallpaper\nMetadata table:\na1 | Aurora Borealis Desktop Wallpapers | wallpaperaccess.com | - | 3840x2160\na2 | ... | - | ..." },
        { type: "image", data, mimeType: "image/jpeg" },
      ],
      timestamp: Date.now(),
    },
  ],
  tools: [selectTool, rejectTool, refineTool],
};

console.log("image bytes:", jpeg.length);
try {
  const msg = (await models.streamSimple(visionModel, context, {}).result()) as {
    stopReason?: string;
    errorMessage?: string;
    content?: { type: string; name?: string; arguments?: unknown; text?: string }[];
  };
  console.log("stopReason:", msg.stopReason);
  console.log("errorMessage:", msg.errorMessage ?? "-");
  for (const c of msg.content ?? []) {
    if (c.type === "toolCall") console.log("TOOLCALL:", c.name, JSON.stringify(c.arguments));
    if (c.type === "text") console.log("TEXT:", String(c.text).slice(0, 600));
  }
} catch (e) {
  console.error("THREW:", e instanceof Error ? e.stack : e);
  process.exit(1);
}
