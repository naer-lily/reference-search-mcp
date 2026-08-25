import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Type } from "typebox";

const models = builtinModels();
const model = models.getModel("deepseek", "deepseek-v4-flash");
if (!model) {
  console.error("model not found");
  process.exit(1);
}

const tool = {
  name: "submit_keywords",
  description: "Submit the final keyword set for the image search.",
  parameters: Type.Object(
    {
      terms: Type.Array(Type.String({ description: "search terms" }), { minItems: 1 }),
      negative_terms: Type.Optional(Type.Array(Type.String())),
      criteria: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
};

const context = {
  systemPrompt:
    "You plan search keywords for an image search engine. Given a natural-language request, produce a compact keyword set. Call submit_keywords exactly once with the final set.",
  messages: [
    {
      role: "user",
      content: "Request: space nebula illustration\nStyle/quality criteria: dark background, no text overlay",
      timestamp: Date.now(),
    },
  ],
  tools: [tool],
};

try {
  const msg = (await models.streamSimple(model, context, {}).result()) as {
    stopReason?: string;
    content?: { type: string; name?: string; arguments?: unknown; text?: string }[];
    errorMessage?: string;
  };
  console.log("stopReason:", msg.stopReason);
  console.log("errorMessage:", msg.errorMessage ?? "-");
  console.log("content:", JSON.stringify(msg.content, null, 1).slice(0, 1200));
} catch (e) {
  console.error("THREW:", e instanceof Error ? e.stack : e);
  process.exit(1);
}
