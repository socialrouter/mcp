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
  version: "0.1.0",
});

// ─── Tools ───────────────────────────────────────────────

server.registerTool(
  "extract",
  {
    title: "Extract social data",
    description: "Extract data from a social media URL (LinkedIn, Instagram, X, Reddit). Pick the extraction type matching the URL kind.",
    inputSchema: {
      url: z.string().describe("The full URL of the social media content"),
      type: z
        .enum(["post.likes", "post.comments", "profile.info", "profile.posts", "profile.followers"])
        .describe("What to extract from the URL"),
      limit: z.number().int().positive().optional().describe("Maximum number of results to return (default 100)"),
      provider: z.string().optional().describe("Optional provider override (e.g. 'lobstr', 'apify'). Omit to let SocialRouter route automatically."),
    },
  },
  async ({ url, type, limit, provider }) => {
    const result = await client.extract({ url, type, limit, provider });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "list_providers",
  {
    title: "List providers",
    description: "List all available data extraction providers and their status",
    inputSchema: {},
  },
  async () => {
    const providers = await client.listProviders();
    return { content: [{ type: "text" as const, text: JSON.stringify(providers, null, 2) }] };
  }
);

server.registerTool(
  "get_balance",
  {
    title: "Get balance",
    description: "Check your SocialRouter credit balance",
    inputSchema: {},
  },
  async () => {
    const balance = await client.getBalance();
    return { content: [{ type: "text" as const, text: `Balance: $${balance.balance.toFixed(2)} ${balance.currency}` }] };
  }
);

server.registerTool(
  "get_extraction",
  {
    title: "Get extraction",
    description: "Get the result of a previous extraction by its ID",
    inputSchema: {
      id: z.string().describe("The extraction ID (e.g., ext_abc123)"),
    },
  },
  async ({ id }) => {
    const result = await client.getExtraction(id);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── Start ───────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
