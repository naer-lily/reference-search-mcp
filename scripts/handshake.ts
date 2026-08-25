/**
 * MCP stdio handshake check: build first (`npm run build`), then:
 *   npx tsx scripts/handshake.ts --query "cat" --keywords cat
 * Verifies tools/list + one tool call round-trip through the real server.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const query = arg("query") ?? "space nebula";
  const keywords = arg("keywords")?.split(",").map((s) => s.trim()).filter(Boolean);

  const env = { ...process.env, PROVIDERS: process.env.PROVIDERS ?? "ddg,bing,wikimedia" };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    cwd: root,
    env,
  });
  const client = new Client({ name: "handshake", version: "0.0.1" });
  await client.connect(transport);
  console.log("connected; tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));

  const res = await client.callTool({
    name: "image_search_start",
    arguments: { query, ...(keywords ? { keywords } : {}) },
  });
  const text = res.content.find((c): c is { type: "text"; text: string } => c.type === "text")?.text ?? "";
  console.log(text);
  await client.close();
}

main().catch((e) => {
  console.error("handshake failed:", e);
  process.exit(1);
});
