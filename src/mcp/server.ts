import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { SearchService } from "../service.js";

function textJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function wrap<TArgs>(fn: (args: TArgs) => Promise<unknown>): (args: TArgs) => Promise<{ content: { type: "text"; text: string }[] }> {
  return async (args) => {
    try {
      return textJson(await fn(args));
    } catch (e) {
      if (e instanceof McpError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof Error && e.name === "UserError") {
        throw new McpError(ErrorCode.InvalidParams, msg);
      }
      throw new McpError(ErrorCode.InternalError, msg);
    }
  };
}

export function createMcpServer(service: SearchService): McpServer {
  const server = new McpServer(
    { name: "reference-search", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "image_search_start",
    {
      title: "Start an image search session",
      description:
        "Parse a natural-language query into keywords (unless keywords are given), search all configured " +
        "image providers in parallel, dedupe, render a numbered composite grid (round 'a', cell ids a1..aN), " +
        "and run a multimodal filter that returns the selected cell ids. Returns the grid file path, the " +
        "selected ids, the metadata table, and the keywords actually used.",
      inputSchema: {
        query: z.string().describe("Natural-language image request, e.g. 'space nebula illustrations for a podcast cover'"),
        keywords: z.array(z.string()).optional().describe("Explicit search keywords; skips LLM parsing when given"),
        criteria: z.string().optional().describe("Style / quality criteria for filtering, e.g. 'flat vector, no text, dark background'"),
        count: z.number().int().positive().max(120).optional().describe("Max candidates in this round (default: grid capacity)"),
        safe_search: z.boolean().optional(),
        filter: z
          .boolean()
          .optional()
          .describe(
            "false = skip the server-side vision filter and return all candidates (use when the calling model is multimodal " +
              "and will look at the grid itself); default follows FILTER_MODE",
          ),
      },
    },
    wrap(async (args) => {
      const { query, keywords, criteria, count, safe_search, filter } = args as {
        query: string;
        keywords?: string[];
        criteria?: string;
        count?: number;
        safe_search?: boolean;
        filter?: boolean;
      };
      return service.start(query, { keywords, criteria, count, safeSearch: safe_search, filter });
    }),
  );

  server.registerTool(
    "image_search_iterate",
    {
      title: "Iterate on an existing search session",
      description:
        "Give feedback referencing round-qualified ids (e.g. 'keep a3, more like b7, no photos') plus optional " +
        "explicit keywords. Produces the next round (b, c, ...) with dedup against all previously shown images. " +
        "The LLM interprets the feedback into keyword additions/removals via refine_search.",
      inputSchema: {
        session_id: z.string(),
        feedback: z.string().describe("Natural-language feedback; may reference cell ids like a3 / b12"),
        keywords: z.array(z.string()).optional().describe("Explicit keyword replacement; skips LLM feedback interpretation"),
        criteria: z.string().optional(),
        count: z.number().int().positive().max(120).optional(),
        safe_search: z.boolean().optional(),
        filter: z.boolean().optional().describe("false = skip the server-side vision filter for this round"),
      },
    },
    wrap(async (args) => {
      const { session_id, feedback, keywords, criteria, count, safe_search, filter } = args as {
        session_id: string;
        feedback: string;
        keywords?: string[];
        criteria?: string;
        count?: number;
        safe_search?: boolean;
        filter?: boolean;
      };
      return service.iterate(session_id, feedback, { keywords, criteria, count, safeSearch: safe_search, filter });
    }),
  );

  server.registerTool(
    "image_search_collect",
    {
      title: "Download the full images for chosen cell ids",
      description:
        "Download the full-resolution images for a list of round-qualified ids (e.g. ['a3', 'b12']) to the " +
        "output directory. Returns local file paths plus a manifest with source URLs and licenses.",
      inputSchema: {
        session_id: z.string(),
        ids: z.array(z.string()).min(1),
      },
    },
    wrap(async (args) => {
      const { session_id, ids } = args as { session_id: string; ids: string[] };
      return service.collect(session_id, ids);
    }),
  );

  server.registerTool(
    "image_search_status",
    {
      title: "Show session state",
      description: "Rounds so far, per-round selections/rejections, current keywords, and collected ids.",
      inputSchema: { session_id: z.string() },
    },
    wrap(async (args) => {
      const { session_id } = args as { session_id: string };
      return service.status(session_id);
    }),
  );

  return server;
}

export async function serveStdio(service: SearchService): Promise<void> {
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { McpError, ErrorCode };
