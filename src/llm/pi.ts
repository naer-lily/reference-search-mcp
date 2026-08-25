/**
 * LLM layer on top of @earendil-works/pi-ai.
 *
 * Results are delivered via TOOL CALLS, not raw JSON text:
 * - the provider enforces the tool schema, so arguments arrive as valid JSON;
 * - invalid arguments are corrected by the model after an error tool result;
 * - multi-intent (select + reject + refine) happens in a single turn.
 * A bounded loop (maxTurns) drives tool execution with result receipts.
 * If the model does not call tools, plain-text JSON is parsed as a fallback
 * (parseJsonWithRepair + typebox validation).
 */

import {
  createProvider,
  envApiKeyAuth,
  lazyApi,
  retryAssistantCall,
  parseJsonWithRepair,
  type Api,
  type AssistantMessage,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type Models,
  type RetryPolicy,
  type TextContent,
  type ThinkingLevel,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { Config } from "../config.js";
import type { FeedbackPlan, FilterResult } from "../types.js";

export type ThinkingSetting = Config["piThinking"];

const RETRY_POLICY: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1000 };

const TEXT_PROVIDER_PREFERENCE = [
  "deepseek",
  "moonshotai",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "minimax",
  "qwen-token-plan",
  "qwen-token-plan-cn",
];

export interface ToolExecution {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolLoopOutcome {
  message: AssistantMessage;
  calls: ToolExecution[];
  finalText: string;
}

/** Minimal interface so the service can run with a stub LLM in tests. */
export interface Llm {
  readonly ready: boolean;
  parseKeywords(query: string, criteria?: string): Promise<string[] | null>;
  interpretFeedback(input: FeedbackInput): Promise<FeedbackPlan | null>;
  filterGrid(input: FilterGridInput): Promise<FilterResult | null>;
}

export interface FeedbackInput {
  query: string;
  criteria?: string;
  currentKeywords: string[];
  /** Previous rounds summary: "a: 3 selected, 45 rejected..." + metadata table. */
  roundsSummary: string;
  feedback: string;
}

export interface FilterGridInput {
  query: string;
  criteria?: string;
  keywords: string[];
  roundLetter: string;
  /** Valid cell ids for this round, e.g. ["a1", ..., "a48"]. */
  validIds: string[];
  metadataTable: string;
  /** JPEG-encoded grid image. */
  image: { data: string; mimeType: string };
}

// ---------- tool schemas (typebox) ----------

const submitKeywordsParams = Type.Object(
  {
    terms: Type.Array(Type.String({ description: "search terms; mix languages and synonyms" }), { minItems: 1 }),
    negative_terms: Type.Optional(Type.Array(Type.String())),
    criteria: Type.Optional(Type.String({ description: "style / quality criteria for the curator" })),
  },
  { additionalProperties: false },
);
type SubmitKeywordsArgs = Static<typeof submitKeywordsParams>;

const selectParams = Type.Object(
  {
    ids: Type.Array(Type.String({ description: "valid cell ids, e.g. a3" })),
    note: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const rejectParams = Type.Object(
  { ids: Type.Array(Type.String()) },
  { additionalProperties: false },
);

const refineParams = Type.Object(
  {
    add_terms: Type.Array(Type.String()),
    remove_terms: Type.Array(Type.String()),
    criteria: Type.Optional(Type.String()),
    more_pages: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
type RefineArgs = Static<typeof refineParams>;

const SUBMIT_KEYWORDS_TOOL: Tool = {
  name: "submit_keywords",
  description: "Submit the final keyword set for the image search.",
  parameters: submitKeywordsParams,
};
const SELECT_TOOL: Tool = {
  name: "select_images",
  description: "Mark grid cells to keep. Only valid cell ids may be used.",
  parameters: selectParams,
};
const REJECT_TOOL: Tool = {
  name: "reject_images",
  description: "Mark grid cells as clearly irrelevant.",
  parameters: rejectParams,
};
const REFINE_TOOL: Tool = {
  name: "refine_search",
  description: "Propose keyword changes for the next search round.",
  parameters: refineParams,
};

// ---------- helpers ----------

function textOf(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function isToolCall(c: AssistantMessage["content"][number]): c is ToolCall {
  return c.type === "toolCall";
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function splitModelRef(ref: string): { provider: string; model: string } {
  const idx = ref.indexOf("/");
  if (idx <= 0 || idx === ref.length - 1) throw new Error(`PI model ref must be "provider/model", got "${ref}"`);
  return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
}

// ---------- PiLlm ----------

export class PiLlm implements Llm {
  private constructor(
    private readonly models: Models,
    private readonly textModel: Model<Api> | undefined,
    private readonly visionModel: Model<Api> | undefined,
    private readonly thinking: ThinkingLevel | undefined,
    private readonly maxTurns: number,
  ) {}

  static async create(cfg: Config): Promise<PiLlm> {
    const models = builtinModels();

    if (cfg.customProvider) {
      const cp = cfg.customProvider;
      const api = lazyApi(() => import(`@earendil-works/pi-ai/api/${cp.api}`));
      const provider = createProvider({
        id: cp.id,
        name: cp.id,
        baseUrl: cp.baseUrl,
        auth: { apiKey: envApiKeyAuth(cp.id, [cp.apiKeyEnv]) },
        api,
        models: cp.models.map((id) => ({
          id,
          name: id,
          api: cp.api as Api,
          provider: cp.id,
          baseUrl: cp.baseUrl,
          reasoning: false,
          input: ["text", "image"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8192,
        })),
      });
      models.setProvider(provider);
    }

    let textModel: Model<Api> | undefined;
    if (cfg.piTextModel) {
      const { provider, model } = splitModelRef(cfg.piTextModel);
      textModel = models.getModel(provider, model);
      if (!textModel) throw new Error(`PI_TEXT_MODEL "${cfg.piTextModel}" not found in model catalog`);
    } else {
      textModel = await pickDefaultModel(models, TEXT_PROVIDER_PREFERENCE);
    }

    let visionModel: Model<Api> | undefined;
    if (cfg.piVisionModel) {
      const { provider, model } = splitModelRef(cfg.piVisionModel);
      visionModel = models.getModel(provider, model);
      if (!visionModel) throw new Error(`PI_VISION_MODEL "${cfg.piVisionModel}" not found in model catalog`);
    } else {
      // Many text models are multimodal; the filter falls back to the text model.
      visionModel = textModel;
    }

    const thinking = cfg.piThinking === "off" ? undefined : (cfg.piThinking as ThinkingLevel | undefined);
    return new PiLlm(models, textModel, visionModel, thinking, cfg.llmMaxTurns);
  }

  get ready(): boolean {
    return this.textModel !== undefined;
  }

  // ---------- public API ----------

  async parseKeywords(query: string, criteria?: string): Promise<string[] | null> {
    if (!this.textModel) return null;
    const system =
      "You plan search keywords for an image search engine. Given a natural-language request, " +
      "produce a compact keyword set (mix languages and synonyms, include style words like " +
      '"photo", "illustration", "3d render", "flat design"). Call submit_keywords exactly once with the final set.';
    const user = `Request: ${query}${criteria ? `\nStyle/quality criteria: ${criteria}` : ""}`;
    const outcome = await this.runToolLoop(this.textModel, system, user, [SUBMIT_KEYWORDS_TOOL], async (call) => {
      const args = call.arguments as SubmitKeywordsArgs;
      const terms = asStrings(args.terms).map((s) => s.trim()).filter(Boolean);
      if (terms.length === 0) return { content: "terms must contain at least one non-empty search term", isError: true };
      return { content: `accepted ${terms.length} terms` };
    });
    const call = outcome.calls.find((c) => c.name === "submit_keywords");
    if (call) {
      const args = call.args as SubmitKeywordsArgs;
      const terms = asStrings(args.terms).map((s) => s.trim()).filter(Boolean);
      if (terms.length > 0) return dedupe(terms);
    }
    // fallback: parse plain-text JSON
    return this.fallbackJson<string[]>(outcome.finalText, Type.Array(Type.String({ minLength: 1 })));
  }

  async interpretFeedback(input: FeedbackInput): Promise<FeedbackPlan | null> {
    if (!this.textModel) return null;
    const system =
      "You refine an ongoing image search. The user gives feedback referencing round ids " +
      '(like "a3" or "b12") and style preferences. Call refine_search with keyword adjustments. ' +
      "Terms that describe unwanted content go to remove_terms; new directions go to add_terms.";
    const user =
      `Query: ${input.query}\n` +
      `Current keywords: ${input.currentKeywords.join(", ")}\n` +
      (input.criteria ? `Criteria: ${input.criteria}\n` : "") +
      `Rounds so far:\n${input.roundsSummary}\n` +
      `User feedback: ${input.feedback}`;
    const outcome = await this.runToolLoop(this.textModel, system, user, [REFINE_TOOL], async () => ({
      content: "recorded",
    }));
    const call = outcome.calls.find((c) => c.name === "refine_search");
    if (call) return this.toFeedbackPlan(call.args as RefineArgs);
    return this.fallbackJson<FeedbackPlan>(
      outcome.finalText,
      Type.Object(
        {
          addTerms: Type.Array(Type.String()),
          removeTerms: Type.Array(Type.String()),
          criteria: Type.Optional(Type.String()),
          morePages: Type.Optional(Type.Integer()),
        },
        { additionalProperties: false },
      ),
      {
        map: (v) => ({
          addTerms: asStrings((v as Record<string, unknown>).addTerms),
          removeTerms: asStrings((v as Record<string, unknown>).removeTerms),
          criteria: typeof (v as Record<string, unknown>).criteria === "string" ? ((v as Record<string, unknown>).criteria as string) : undefined,
          morePages: typeof (v as Record<string, unknown>).morePages === "number" ? ((v as Record<string, unknown>).morePages as number) : undefined,
        }),
      },
    );
  }

  async filterGrid(input: FilterGridInput): Promise<FilterResult | null> {
    const model = this.visionModel ?? this.textModel;
    if (!model) return null;
    const system =
      "You are an expert image curator. You are shown a numbered contact sheet of search results " +
      `(round ${input.roundLetter.toUpperCase()}, cells ${input.validIds[0]}..${input.validIds.at(-1)}) plus a metadata table. ` +
      "Pick the images that best match the query and criteria: relevant, high quality, style-consistent, " +
      "no watermarks or text overlays when avoidable. Use the tools:\n" +
      "- select_images: keep these cells.\n" +
      "- reject_images: mark clearly irrelevant cells (optional).\n" +
      "- refine_search: propose next-round keyword changes (optional).\n" +
      "Only valid cell ids may be used. You may call tools several times.";
    const userContent: (TextContent | ImageContent)[] = [
      {
        type: "text",
        text:
          `Query: ${input.query}\n` +
          (input.criteria ? `Criteria: ${input.criteria}\n` : "") +
          `Keywords: ${input.keywords.join(", ")}\n` +
          `Metadata table (id | title | source | license | size):\n${input.metadataTable}`,
      },
      { type: "image", data: input.image.data, mimeType: input.image.mimeType },
    ];

    const valid = new Set(input.validIds);
    const selected: string[] = [];
    const rejected: string[] = [];
    const reasons: Record<string, string> = {};
    let refine: FeedbackPlan | undefined;
    let note: string | undefined;

    const outcome = await this.runToolLoop(model, system, userContent, [SELECT_TOOL, REJECT_TOOL, REFINE_TOOL], async (call) => {
      const args = call.arguments as { ids?: unknown; note?: unknown } & RefineArgs;
      switch (call.name) {
        case "select_images": {
          const ids = asStrings(args.ids).filter(Boolean);
          const invalid = ids.filter((id) => !valid.has(id));
          if (invalid.length > 0) {
            return {
              content: `invalid ids: ${invalid.join(", ")}; valid ids are ${input.validIds[0]}..${input.validIds.at(-1)}`,
              isError: true,
            };
          }
          for (const id of ids) {
            if (!selected.includes(id)) selected.push(id);
            const n = typeof args.note === "string" ? args.note : "";
            if (n) reasons[id] = n;
          }
          return { content: `recorded ${ids.length} selections` };
        }
        case "reject_images": {
          const ids = asStrings(args.ids).filter(Boolean);
          const invalid = ids.filter((id) => !valid.has(id));
          if (invalid.length > 0) {
            return { content: `invalid ids: ${invalid.join(", ")}; valid ids are ${input.validIds[0]}..${input.validIds.at(-1)}`, isError: true };
          }
          for (const id of ids) if (!rejected.includes(id)) rejected.push(id);
          return { content: `recorded ${ids.length} rejections` };
        }
        case "refine_search": {
          refine = this.toFeedbackPlan(args);
          return { content: "recorded" };
        }
        default:
          return { content: `unknown tool ${call.name}`, isError: true };
      }
    });

    const cleanedSelected = selected.filter((id) => !rejected.includes(id));
    if (outcome.finalText.trim()) note = outcome.finalText.trim().slice(0, 500);

    // fallback: no tool calls — parse plain-text JSON
    if (outcome.calls.length === 0) {
      const parsed = this.fallbackJson<{ selected?: unknown; rejected?: unknown; reasons?: unknown; refine?: unknown; note?: string }>(
        outcome.finalText,
        Type.Object(
          {
            selected: Type.Optional(Type.Array(Type.String())),
            rejected: Type.Optional(Type.Array(Type.String())),
            reasons: Type.Optional(Type.Record(Type.String(), Type.String())),
            refine: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            note: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      );
      if (parsed) {
        const sel = asStrings(parsed.selected).filter((id) => valid.has(id));
        const rej = asStrings(parsed.rejected).filter((id) => valid.has(id));
        return {
          selected: sel.filter((id) => !rej.includes(id)),
          rejected: rej,
          reasons: parsed.reasons && typeof parsed.reasons === "object" ? (parsed.reasons as Record<string, string>) : {},
          refine: parsed.refine ? this.toFeedbackPlan(parsed.refine as RefineArgs) : undefined,
          note: parsed.note ?? note,
        };
      }
    }

    return { selected: cleanedSelected, rejected, reasons, refine, note };
  }

  // ---------- internals ----------

  private toFeedbackPlan(args: RefineArgs): FeedbackPlan {
    return {
      addTerms: asStrings(args.add_terms).map((s) => s.trim()).filter(Boolean),
      removeTerms: asStrings(args.remove_terms).map((s) => s.trim()).filter(Boolean),
      criteria: typeof args.criteria === "string" && args.criteria.trim() ? args.criteria.trim() : undefined,
      morePages: typeof args.more_pages === "number" ? args.more_pages : undefined,
    };
  }

  /** Bounded tool loop. Returns after the model stops (no toolUse) or maxTurns. */
  private async runToolLoop(
    model: Model<Api>,
    system: string,
    userContent: string | (TextContent | ImageContent)[],
    tools: Tool[],
    execute: (call: ToolCall) => Promise<{ content: string; isError?: boolean }>,
  ): Promise<ToolLoopOutcome> {
    const messages: Message[] = [{ role: "user", content: userContent, timestamp: Date.now() }];
    const calls: ToolExecution[] = [];
    let last: AssistantMessage | undefined;
    for (let turn = 0; turn < this.maxTurns; turn++) {
      last = await this.call(model, system, messages, tools);
      messages.push(last);
      const toolCalls = last.content.filter(isToolCall);
      calls.push(...toolCalls.map((c) => ({ name: c.name, args: c.arguments })));
      if (last.stopReason !== "toolUse" || toolCalls.length === 0) break;
      for (const call of toolCalls) {
        const r = await execute(call);
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: r.content }],
          isError: r.isError ?? false,
          timestamp: Date.now(),
        });
      }
    }
    return { message: last!, calls, finalText: last ? textOf(last) : "" };
  }

  private async call(model: Model<Api>, system: string, messages: Message[], tools: Tool[]): Promise<AssistantMessage> {
    const context: Context = { systemPrompt: system, messages, tools };
    const options: { reasoning?: ThinkingLevel; temperature?: number } = {};
    if (this.thinking) options.reasoning = this.thinking;
    // Models.streamSimple resolves provider auth (env vars / credential store)
    // and dispatches to the provider adapter.
    const produce = () => this.models.streamSimple(model, context, options).result();
    return retryAssistantCall(produce, RETRY_POLICY, undefined);
  }

  private fallbackJson<T>(
    text: string,
    schema: TSchema,
    opts?: { map?: (v: unknown) => T },
  ): T | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    let parsed: unknown;
    try {
      parsed = parseJsonWithRepair<T>(trimmed);
    } catch {
      return null;
    }
    if (!Value.Check(schema, parsed)) return null;
    return opts?.map ? opts.map(parsed) : (parsed as T);
  }
}

async function pickDefaultModel(models: Models, preference: string[]): Promise<Model<Api> | undefined> {
  for (const pid of preference) {
    const provider = models.getProvider(pid);
    if (!provider) continue;
    try {
      const auth = await models.getAuth(pid);
      if (!auth) continue;
    } catch {
      continue;
    }
    const list = provider.getModels();
    const m = list.find((x) => x.input.includes("text"));
    if (m) return m;
  }
  return undefined;
}

function dedupe(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}
