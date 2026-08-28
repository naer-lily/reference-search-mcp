/**
 * LLM layer on top of @earendil-works/pi-ai.
 *
 * Results are delivered EXCLUSIVELY via TOOL CALLS — never raw JSON text:
 * - the provider enforces the tool schema, so arguments arrive as valid JSON;
 * - invalid arguments are corrected by the model after an error tool result;
 * - multi-intent (select + reject + refine) happens in a single turn.
 *
 * Tool-choice strategy (measured against DeepSeek v4-flash, 2026-08):
 * - thinking ON (default): the API rejects forced tool_choice ("Thinking mode
 *   does not support this tool_choice"), so we use toolChoice "auto" and, when
 *   the model answers with text instead of calling a tool, we nudge it with a
 *   follow-up user message ("you must call the tool") up to maxTurns.
 * - thinking OFF (PI_THINKING=off): tool_choice is forced to the target
 *   function (openai-completions: {type:"function",function:{name}}, plus
 *   reasoning_effort "none" via samplingParams for DeepSeek).
 * There is NO text-JSON fallback anywhere: if the model never calls a tool,
 * the call fails with LlmDeliveryError.
 */

import {
  createProvider,
  envApiKeyAuth,
  lazyApi,
  retryAssistantCall,
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
import { Type, type Static } from "typebox";
import type { Config } from "../config.js";
import type { FeedbackPlan, FilterResult } from "../types.js";

export type ThinkingSetting = Config["piThinking"];

/** The model answered without calling any tool after the loop exhausted its turns. */
export class LlmDeliveryError extends Error {}

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

/** One keyword group, e.g. { label: "侧面", terms: ["M1911 side view", ...] }. */
export interface KeywordGroup {
  label: string;
  terms: string[];
}

/** Result of keyword parsing: main terms plus optional per-aspect groups. */
export interface KeywordPlan {
  terms: string[];
  groups?: KeywordGroup[];
}

/** Minimal interface so the service can run with a stub LLM in tests. */
export interface Llm {
  readonly ready: boolean;
  parseKeywords(query: string, criteria?: string): Promise<KeywordPlan | null>;
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

const keywordGroupParams = Type.Object(
  {
    label: Type.String({ description: "short aspect label, e.g. 正面 / side view" }),
    terms: Type.Array(Type.String({ description: "search terms for this aspect" }), { minItems: 1 }),
  },
  { additionalProperties: false },
);

const submitKeywordsParams = Type.Object(
  {
    terms: Type.Array(Type.String({ description: "search terms; mix languages and synonyms" }), { minItems: 1 }),
    negative_terms: Type.Optional(Type.Array(Type.String())),
    criteria: Type.Optional(Type.String({ description: "style / quality criteria for the curator" })),
    groups: Type.Optional(
      Type.Array(keywordGroupParams, {
        description:
          "optional per-aspect keyword groups (e.g. front/side/rear views) when the request asks for multiple aspects; each group is searched in parallel",
      }),
    ),
  },
  { additionalProperties: false },
);
type SubmitKeywordsArgs = Static<typeof submitKeywordsParams>;

const selectParams = Type.Object(
  {
    ids: Type.Array(Type.String({ description: "valid cell ids, e.g. a3" })),
    note: Type.Optional(
      Type.String({
        description:
          "one-sentence Chinese visual description of THIS selection, for art reference: angle / composition / lighting / style. Only describe the images in ids, one description per image.",
      }),
    ),
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
  description:
    "Submit the final keyword set for the image search. If the request asks for multiple aspects " +
    "(e.g. all angles of an object), also provide one group per aspect via the groups field.",
  parameters: submitKeywordsParams,
};
const SELECT_TOOL: Tool = {
  name: "select_images",
  description: "Mark grid cells to keep. Only valid cell ids may be used. Fill note with a one-sentence visual description of each kept image.",
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

  async parseKeywords(query: string, criteria?: string): Promise<KeywordPlan | null> {
    if (!this.textModel) return null;
    const system =
      "You plan search keywords for an image search engine. Given a natural-language request, " +
      "produce a compact keyword set (mix languages and synonyms, include style words like " +
      '"photo", "illustration", "3d render", "flat design"). ' +
      'If the request asks for multiple aspects of a subject (e.g. "all angles of a pistol": ' +
      "front, side, three-quarter, rear, top, bottom), also provide one group per aspect via the groups field. " +
      "Call submit_keywords exactly once with the final set; do not answer with text.";
    const user = `Request: ${query}${criteria ? `\nStyle/quality criteria: ${criteria}` : ""}`;
    const outcome = await this.runToolLoop(this.textModel, system, user, [SUBMIT_KEYWORDS_TOOL], async (call) => {
      const args = call.arguments as SubmitKeywordsArgs;
      const terms = asStrings(args.terms).map((s) => s.trim()).filter(Boolean);
      if (terms.length === 0) return { content: "terms must contain at least one non-empty search term", isError: true };
      return { content: `accepted ${terms.length} terms${Array.isArray(args.groups) ? ` + ${args.groups.length} groups` : ""}` };
    });
    const call = outcome.calls.find((c) => c.name === "submit_keywords");
    if (!call) {
      throw new LlmDeliveryError(
        `模型未调用 submit_keywords 工具（模型用文本回答了，工具调用是唯一交付通道）。` +
          `请检查模型是否支持工具调用；也可设 PI_THINKING=off 切换为强制工具调用模式。`,
      );
    }
    const args = call.args as SubmitKeywordsArgs;
    const terms = asStrings(args.terms).map((s) => s.trim()).filter(Boolean);
    if (terms.length === 0) {
      throw new LlmDeliveryError("模型调用了 submit_keywords 但未提供有效关键词");
    }
    const groups = (Array.isArray(args.groups) ? args.groups : [])
      .map((g) => ({
        label: typeof g?.label === "string" ? g.label.trim() : "",
        terms: asStrings(g?.terms).map((s) => s.trim()).filter(Boolean),
      }))
      .filter((g) => g.label && g.terms.length > 0);
    return { terms: dedupe(terms), groups: groups.length > 0 ? groups : undefined };
  }

  async interpretFeedback(input: FeedbackInput): Promise<FeedbackPlan | null> {
    if (!this.textModel) return null;
    const system =
      "You refine an ongoing image search. The user gives feedback referencing round ids " +
      '(like "a3" or "b12") and style preferences. Call refine_search with keyword adjustments. ' +
      "Terms that describe unwanted content go to remove_terms; new directions go to add_terms. " +
      "Do not answer with text.";
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
    if (!call) {
      throw new LlmDeliveryError(
        `模型未调用 refine_search 工具（模型用文本回答了，工具调用是唯一交付通道）。` +
          `请检查模型是否支持工具调用；也可设 PI_THINKING=off 切换为强制工具调用模式。`,
      );
    }
    return this.toFeedbackPlan(call.args as RefineArgs);
  }

  async filterGrid(input: FilterGridInput): Promise<FilterResult | null> {
    const model = this.visionModel ?? this.textModel;
    if (!model) return null;
    const system =
      "You are an expert image curator. You are shown a numbered contact sheet of search results " +
      `(round ${input.roundLetter.toUpperCase()}, cells ${input.validIds[0]}..${input.validIds.at(-1)}) plus a metadata table. ` +
      "Pick the images that best match the query and criteria: relevant, high quality, style-consistent, " +
      "no watermarks or text overlays when avoidable. Use the tools:\n" +
      "- select_images: keep these cells. Fill note with one-sentence Chinese visual descriptions of the kept " +
      "images, one per image in the same order as ids (angle / composition / lighting / style), for art reference.\n" +
      "- reject_images: mark clearly irrelevant cells (optional).\n" +
      "- refine_search: propose next-round keyword changes (optional).\n" +
      "Only valid cell ids may be used. You may call tools several times; do not answer with text.";
    const userContent: (TextContent | ImageContent)[] = [
      {
        type: "text",
        text:
          `Query: ${input.query}\n` +
          (input.criteria ? `Criteria: ${input.criteria}\n` : "") +
          `Keywords: ${input.keywords.join(", ")}\n` +
          `Metadata table (id | group | title | source | license | size):\n${input.metadataTable}`,
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
            const n = typeof args.note === "string" ? args.note.trim() : "";
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

    if (outcome.calls.length === 0) {
      throw new LlmDeliveryError(
        `模型未调用任何工具（select_images / reject_images / refine_search）——工具调用是唯一交付通道。` +
          `请检查模型是否支持工具调用；也可设 PI_THINKING=off 切换为强制工具调用模式。`,
      );
    }

    const cleanedSelected = selected.filter((id) => !rejected.includes(id));
    if (outcome.finalText.trim()) note = outcome.finalText.trim().slice(0, 500);
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

  /**
   * Bounded tool loop. When the model answers with text instead of calling a
   * tool (stopReason "stop"), a follow-up user message demands a tool call and
   * the loop continues. When thinking is OFF, call() forces tool_choice, so
   * text answers should not happen at all. No text parsing anywhere.
   */
  private async runToolLoop(
    model: Model<Api>,
    system: string,
    userContent: string | (TextContent | ImageContent)[],
    tools: Tool[],
    execute: (call: ToolCall) => Promise<{ content: string; isError?: boolean }>,
    forceTool?: string | "required",
  ): Promise<ToolLoopOutcome> {
    const messages: Message[] = [{ role: "user", content: userContent, timestamp: Date.now() }];
    const calls: ToolExecution[] = [];
    let last: AssistantMessage | undefined;
    for (let turn = 0; turn < this.maxTurns; turn++) {
      last = await this.call(model, system, messages, tools, forceTool);
      messages.push(last);
      const toolCalls = last.content.filter(isToolCall);
      calls.push(...toolCalls.map((c) => ({ name: c.name, args: c.arguments })));
      if (toolCalls.length > 0) {
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
        continue;
      }
      // no tool calls this turn
      if (last.stopReason !== "stop") break; // error/aborted/length: nudging is pointless
      if (turn < this.maxTurns - 1) {
        messages.push({
          role: "user",
          content: `你还没有调用任何工具。你必须调用 ${tools.map((t) => t.name).join(" 或 ")} 完成本任务，禁止用文本回答。`,
          timestamp: Date.now(),
        });
        continue;
      }
      break;
    }
    return { message: last!, calls, finalText: last ? textOf(last) : "" };
  }

  private async call(
    model: Model<Api>,
    system: string,
    messages: Message[],
    tools: Tool[],
    forceTool?: string | "required",
  ): Promise<AssistantMessage> {
    const context: Context = { systemPrompt: system, messages, tools };
    const options: Record<string, unknown> = {};
    if (this.thinking) {
      options.reasoning = this.thinking;
      // thinking ON: forced tool_choice is rejected by DeepSeek ("Thinking mode
      // does not support this tool_choice") — runToolLoop nudges text answers instead.
    } else if (forceTool) {
      // thinking OFF: force the tool call.
      if (model.api === "openai-completions") {
        options.toolChoice =
          forceTool === "required" ? "required" : { type: "function", function: { name: forceTool } };
        // DeepSeek: required tool_choice is also rejected while thinking; turn it off explicitly.
        options.samplingParams = { reasoning_effort: "none" };
      } else if (model.api === "anthropic-messages") {
        options.toolChoice = forceTool === "required" ? "any" : { type: "tool", name: forceTool };
      } else {
        options.toolChoice = "required";
      }
    }
    // Models.stream resolves provider auth and dispatches to the provider adapter.
    const produce = () => this.models.stream(model, context, options as never).result();
    return retryAssistantCall(produce, RETRY_POLICY, undefined);
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
