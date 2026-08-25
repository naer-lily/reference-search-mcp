import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const distEntry = path.join(root, "dist", "index.js");

let client: Client;
let transport: StdioClientTransport;

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c): c is { type: "text"; text: string } => c.type === "text")?.text ?? "{}";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { isError: res.isError === true, text, parsed };
}

beforeAll(async () => {
  const build = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], {
    cwd: root,
    stdio: "pipe",
  });
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr?.toString()}`);
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined));
  // cwd must NOT contain a .env file (dotenv would configure an LLM); use a temp dir.
  const serverCwd = mkdtempSync(path.join(tmpdir(), "rs-mcp-cwd-"));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry],
    cwd: serverCwd,
    env: {
      ...cleanEnv,
      PROVIDERS: "",
      DATA_DIR: mkdtempSync(path.join(tmpdir(), "rs-mcp-data-")),
      OUT_DIR: mkdtempSync(path.join(tmpdir(), "rs-mcp-out-")),
      SESSION_TTL_MINUTES: "30",
    },
  });
  client = new Client({ name: "rs-mcp-test", version: "0.0.1" });
  await client.connect(transport);
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("MCP server over stdio", () => {
  it("exposes the four tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["image_search_collect", "image_search_iterate", "image_search_start", "image_search_status"]);
  });

  it("start with explicit keywords returns a round result", async () => {
    const r = await call("image_search_start", { query: "test query", keywords: ["cat"] });
    expect(r.isError).toBe(false);
    expect(r.parsed.round).toBe("a");
    expect(typeof r.parsed.sessionId).toBe("string");
    expect(existsSync(r.parsed.gridPath)).toBe(true);
    expect(Array.isArray(r.parsed.selectedIds)).toBe(true);
    expect(Array.isArray(r.parsed.metadata)).toBe(true);
    (globalThis as Record<string, unknown>).__sid = r.parsed.sessionId;
  });

  it("start without keywords fails cleanly when no LLM is configured", async () => {
    const r = await call("image_search_start", { query: "cat" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no LLM");
  });

  it("status reports the created round", async () => {
    const sid = (globalThis as Record<string, unknown>).__sid as string;
    const r = await call("image_search_status", { session_id: sid });
    expect(r.isError).toBe(false);
    expect(r.parsed.rounds).toHaveLength(1);
    expect(r.parsed.rounds[0].round).toBe("a");
  });

  it("iterate with explicit keywords produces round b", async () => {
    const sid = (globalThis as Record<string, unknown>).__sid as string;
    const r = await call("image_search_iterate", { session_id: sid, feedback: "more variety", keywords: ["dog"] });
    expect(r.isError).toBe(false);
    expect(r.parsed.round).toBe("b");
  });

  it("collect reports unknown ids as failures, not protocol errors", async () => {
    const sid = (globalThis as Record<string, unknown>).__sid as string;
    const r = await call("image_search_collect", { session_id: sid, ids: ["zz"] });
    expect(r.isError).toBe(false);
    expect(r.parsed.failures).toHaveLength(1);
    expect(r.parsed.files).toHaveLength(0);
    expect(typeof r.parsed.manifestPath).toBe("string");
  });

  it("maps unknown sessions to InvalidParams", async () => {
    const r = await call("image_search_iterate", { session_id: "bogus", feedback: "x", keywords: ["k"] });
    expect(r.isError).toBe(true);
  });
});
