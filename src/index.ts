#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SocialRouter } from "@socialrouter/sdk";

const apiKey = process.env.SOCIALROUTER_API_KEY;
if (!apiKey) {
  console.error("SOCIALROUTER_API_KEY environment variable is required");
  process.exit(1);
}

const client = new SocialRouter({
  apiKey,
  baseUrl: process.env.SOCIALROUTER_BASE_URL,
});

const server = new McpServer({
  name: "socialrouter",
  version: "0.3.0",
});

// ─── Tools ───────────────────────────────────────────────

server.registerTool(
  "extract",
  {
    title: "Extract social data from URLs",
    description:
      "Run a URL-driven extraction. The `provider` argument is a service slug of the form 'provider/platform/type' (e.g. 'apify/linkedin/profile.info'), with an optional ':tag' suffix to select an actor variant (e.g. 'apify/linkedin/profile.posts:apimaestro'). Find available slugs at https://www.socialrouter.io/providers. Pass either `url` (single) or `urls` (batch — only meaningful for batch-capable actors).",
    inputSchema: {
      url: z
        .string()
        .optional()
        .describe("Single social media URL. Mutually exclusive with `urls`."),
      urls: z
        .array(z.string())
        .nonempty()
        .optional()
        .describe(
          "Batch list of social media URLs. Mutually exclusive with `url`. Only effective for batch-capable actors."
        ),
      provider: z
        .string()
        .describe(
          "Service slug 'provider/platform/type' or 'provider/platform/type:tag' (e.g. 'apify/linkedin/profile.info')."
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of records to return (default 100)."),
      fallback: z
        .boolean()
        .optional()
        .describe(
          "Whether to fall over to alternative providers if the requested one fails (default true)."
        ),
    },
  },
  async ({ url, urls, provider, limit, fallback }) => {
    if (!url && !urls) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: provide either `url` or `urls`.",
          },
        ],
        isError: true,
      };
    }
    const result = await client.extract({ url, urls, provider, limit, fallback });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "search",
  {
    title: "Search via a provider (query-driven)",
    description:
      "Run a query-driven search (companion to `extract`). Use this for services where the input is a search term rather than a URL — currently `place.search` on Google Maps. The `provider` slug grammar is identical to `extract`; the `type` segment must be a search type (e.g. 'apify/googlemaps/place.search' or 'apify/googlemaps/place.search:compass').",
    inputSchema: {
      queries: z
        .array(z.string())
        .nonempty()
        .describe(
          "Non-empty list of search queries. Many actors accept either plain terms or URLs that pin the search context (e.g. a Google Maps URL anchors the search to a location)."
        ),
      provider: z
        .string()
        .describe(
          "Search service slug 'provider/platform/type' or 'provider/platform/type:tag' (e.g. 'apify/googlemaps/place.search')."
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Per-query cap on returned records (default 100)."),
      fallback: z
        .boolean()
        .optional()
        .describe(
          "Whether to fall over to alternative providers if the requested one fails (default true)."
        ),
    },
  },
  async ({ queries, provider, limit, fallback }) => {
    const result = await client.search({ queries, provider, limit, fallback });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "list_providers",
  {
    title: "List providers",
    description:
      "List all available providers, their status, supported platforms, and supported extraction and search types.",
    inputSchema: {},
  },
  async () => {
    const providers = await client.listProviders();
    return { content: [{ type: "text" as const, text: JSON.stringify(providers, null, 2) }] };
  }
);

server.registerTool(
  "get_provider",
  {
    title: "Get provider details",
    description:
      "Get full details for a provider, including per-platform/type pricing for both extraction and search services.",
    inputSchema: {
      id: z.string().describe("Provider ID (e.g. 'apify')."),
    },
  },
  async ({ id }) => {
    const provider = await client.getProvider(id);
    return { content: [{ type: "text" as const, text: JSON.stringify(provider, null, 2) }] };
  }
);

server.registerTool(
  "get_extraction",
  {
    title: "Get extraction or search by ID",
    description:
      "Retrieve a previous extraction or search by its ID. Works for both `kind: extract` and `kind: search` results.",
    inputSchema: {
      id: z.string().describe("The extraction ID (e.g., ext_abc123)."),
    },
  },
  async ({ id }) => {
    const result = await client.getExtraction(id);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "get_balance",
  {
    title: "Get balance",
    description: "Check your SocialRouter credit balance.",
    inputSchema: {},
  },
  async () => {
    const balance = await client.getBalance();
    return {
      content: [
        {
          type: "text" as const,
          text: `Balance: $${balance.balance.toFixed(2)} ${balance.currency}`,
        },
      ],
    };
  }
);

server.registerTool(
  "get_usage",
  {
    title: "Get usage summary",
    description:
      "Get a usage summary for the authenticated account over the last N days, broken down by provider and platform.",
    inputSchema: {
      days: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of days to summarize (default 30)."),
    },
  },
  async ({ days }) => {
    const usage = await client.getUsage(days);
    return { content: [{ type: "text" as const, text: JSON.stringify(usage, null, 2) }] };
  }
);

// ─── Start ───────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
