import { describe, expect, it } from "vitest";
import { LlmDeliveryError, PiLlm, type KeywordPlan } from "../src/llm/pi.js";
import type { Api, AssistantMessage, Context, Model, Models, ThinkingLevel, ToolCall } from "@earendil-works/pi-ai";

type Step = { stopReason: string; content: unknown[] };

function step(stopReason: string, content: unknown[]): Step {
  return { stopReason, content };
}

function textMsg(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function toolCallMsg(name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id: "call_1", name, arguments: args };
}

function asMessage(s: Step): AssistantMessage {
  return {
    role: "assistant",
    content: s.content as AssistantMessage["content"],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    stopReason: s.stopReason as AssistantMessage["stopReason"],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    timestamp: 0,
  };
}

function makeLlm(script: Step[], maxTurns = 3): { llm: PiLlm; seenContexts: Context[] } {
  let callIndex = 0;
  const seenContexts: Context[] = [];
  const fakeModels = {
    stream: (_model: unknown, ctx: Context) => {
      seenContexts.push(ctx);
      const s = script[Math.min(callIndex, script.length - 1)]!;
      callIndex++;
      return { result: async () => asMessage(s) };
    },
  } as unknown as Models;
  const fakeModel = {
    api: "openai-completions",
    provider: "deepseek",
    id: "deepseek-v4-flash",
    name: "test",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 10000,
  } as Model<Api>;
  const llm = new (PiLlm as unknown as new (
    m: Models,
    t: Model<Api> | undefined,
    v: Model<Api> | undefined,
    th: ThinkingLevel | undefined,
    turns: number,
  ) => PiLlm)(fakeModels, fakeModel, undefined, undefined, maxTurns);
  return { llm, seenContexts };
}

describe("PiLlm tool delivery (no JSON fallback)", () => {
  it("nudges a text-answering model until it calls the tool, then returns the plan", async () => {
    const { llm, seenContexts } = makeLlm([
      step("stop", [textMsg("这里是一些关键词：M1911, side view...")]), // model answered with text
      step("toolUse", [toolCallMsg("submit_keywords", { terms: ["M1911 front view", "M1911 side view"] })]),
    ]);
    const plan = await llm.parseKeywords("M1911 各角度");
    expect(plan).toEqual({ terms: ["M1911 front view", "M1911 side view"] } satisfies KeywordPlan);
    // second call must contain the nudging user message
    const secondTurnMessages = seenContexts[1]!.messages;
    const nudge = secondTurnMessages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("必须调用"),
    );
    expect(nudge).toBeDefined();
  });

  it("throws LlmDeliveryError when the model never calls a tool", async () => {
    const { llm } = makeLlm([
      step("stop", [textMsg("answer one")]),
      step("stop", [textMsg("answer two")]),
      step("stop", [textMsg("answer three")]),
    ]);
    await expect(llm.parseKeywords("M1911")).rejects.toThrow(LlmDeliveryError);
  });

  it("returns groups when the model provides them", async () => {
    const { llm } = makeLlm([
      step("toolUse", [
        toolCallMsg("submit_keywords", {
          terms: ["M1911 pistol"],
          groups: [
            { label: "正面", terms: ["M1911 front view", "M1911 正面"] },
            { label: "侧面", terms: ["M1911 side view", "M1911 侧面"] },
          ],
        }),
      ]),
    ]);
    const plan = await llm.parseKeywords("M1911 各角度");
    expect(plan?.terms).toEqual(["M1911 pistol"]);
    expect(plan?.groups).toHaveLength(2);
    expect(plan?.groups?.[0]).toEqual({ label: "正面", terms: ["M1911 front view", "M1911 正面"] });
  });

  it("filterGrid throws LlmDeliveryError when no tool is called", async () => {
    const { llm } = makeLlm([step("stop", [textMsg("I think a1 is good")])]);
    await expect(
      llm.filterGrid({
        query: "test",
        keywords: ["k"],
        roundLetter: "a",
        validIds: ["a1"],
        metadataTable: "a1 | x",
        image: { data: "abc", mimeType: "image/jpeg" },
      }),
    ).rejects.toThrow(LlmDeliveryError);
  });

  it("filterGrid collects select/reject with per-image notes", async () => {
    const { llm } = makeLlm([
      step("toolUse", [
        toolCallMsg("select_images", { ids: ["a1", "a2"], note: "侧面轮廓清晰，金属质感" }),
        toolCallMsg("reject_images", { ids: ["a3"] }),
      ]),
    ]);
    const fr = await llm.filterGrid({
      query: "test",
      keywords: ["k"],
      roundLetter: "a",
      validIds: ["a1", "a2", "a3"],
      metadataTable: "a1 | x\na2 | y\na3 | z",
      image: { data: "abc", mimeType: "image/jpeg" },
    });
    expect(fr?.selected).toEqual(["a1", "a2"]);
    expect(fr?.rejected).toEqual(["a3"]);
    expect(fr?.reasons.a1).toContain("侧面");
  });
});
