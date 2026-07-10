#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SocialRouter, type Platform } from "@socialrouter/sdk";
import {
  CatalogCache,
  checkService,
  type CatalogSnapshot,
  type ServiceKind,
} from "./catalog.js";

const DEFAULT_BASE_URL = "https://api.socialrouter.io";

const apiKey = process.env.SOCIALROUTER_API_KEY;
if (!apiKey) {
  console.error("SOCIALROUTER_API_KEY environment variable is required");
  process.exit(1);
}

const baseUrl = (process.env.SOCIALROUTER_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const client = new SocialRouter({ apiKey, baseUrl, client: "mcp" });
const catalog = new CatalogCache(baseUrl);

const server = new McpServer({
  name: "socialrouter",
  version: "0.5.0",
});

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Enum of the slugs live at startup; free string if a kind has none yet. */
function slugSchema(slugs: string[]): z.ZodType<string> {
  return slugs.length ? z.enum(slugs as [string, ...string[]]) : z.string();
}

interface RunArgs {
  limit?: number;
  variant?: string;
  fallback?: boolean;
  options?: Record<string, unknown>;
}

/**
 * The server is a thin, stateless wrapper over the API: the agent picks a
 * service slug from the catalog (list_services), the MCP validates it against
 * the same catalog before spending a round-trip, and the API does the rest.
 * No URL detection and no routing happen here — that is the API's job.
 */
function registerTools(startup: CatalogSnapshot) {
  const platforms = startup.platforms();
  const types = startup.types();

  // After a successful startup fetch the cache always has a snapshot (stale
  // at worst); the fallback only guards the type.
  const snap = async () => (await catalog.get()) ?? startup;

  const commonParams = {
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum number of records to return (default 100)."),
    variant: z
      .string()
      .optional()
      .describe(
        "Actor variant of the service, appended to the slug as ':variant'. Advanced — omit unless you know the variant exists.",
      ),
    fallback: z
      .boolean()
      .optional()
      .describe(
        "Retry with alternative providers if the requested one fails (default true).",
      ),
    options: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Actor-specific overrides (e.g. proxyCountry, language)."),
  };

  async function run(
    kind: ServiceKind,
    service: string,
    batch: string[],
    args: RunArgs,
  ): Promise<ToolResult> {
    const check = checkService(await snap(), kind, service, batch.length);
    if (check.error) return err(check.error);
    const slug = args.variant ? `${service}:${args.variant}` : service;
    const common = {
      provider: slug,
      limit: args.limit,
      fallback: args.fallback,
      options: args.options,
    };
    const result =
      kind === "search"
        ? await client.search({ queries: batch, ...common })
        : await client.extract({ urls: batch, ...common });
    return ok(result);
  }

  server.registerTool(
    "list_services",
    {
      title: "List available services",
      description:
        "List every service you can call: one row per (provider, platform, type) with price per record and batch cap, cheapest first within each platform/type. Use the 'service' value with the extract or search tool. Filter with 'platform' and/or 'type' to keep the output small.",
      inputSchema: {
        platform: z
          .enum(platforms as [Platform, ...Platform[]])
          .optional()
          .describe("Filter by platform."),
        type: z
          .enum(types as [string, ...string[]])
          .optional()
          .describe("Filter by service type (e.g. 'profile.info')."),
      },
    },
    async ({ platform, type }: { platform?: Platform; type?: string }) =>
      ok((await snap()).services({ platform, type })),
  );

  server.registerTool(
    "extract",
    {
      title: "Extract social data from URLs",
      description:
        `Extract data from social media URLs. 'service' is a '<provider>/<platform>/<type>' slug — pick one from list_services whose platform matches the URLs and whose type matches the data you want (e.g. a LinkedIn profile URL + 'profile.info' for profile data). All URLs in one call must belong to the service's platform. Platforms: ${platforms.join(", ")}.`,
      inputSchema: {
        urls: z
          .array(z.string())
          .nonempty()
          .describe("One or more URLs, all on the service's platform."),
        service: slugSchema(startup.slugs("extract")).describe(
          "Service slug from list_services (e.g. 'brightdata/linkedin/profile.info').",
        ),
        ...commonParams,
      },
    },
    async ({ urls, service, ...args }: { urls: string[]; service: string } & RunArgs) =>
      run("extract", service, urls, args),
  );

  server.registerTool(
    "search",
    {
      title: "Search by text query",
      description:
        "Run a query-driven search (no URL needed). 'service' is a '<provider>/<platform>/<type>' slug whose type ends in '.search' — pick one from list_services.",
      inputSchema: {
        queries: z
          .array(z.string())
          .nonempty()
          .describe("Search terms, or URLs that pin the search context."),
        service: slugSchema(startup.slugs("search")).describe(
          "Search service slug from list_services (e.g. 'apify/googlemaps/place.search').",
        ),
        ...commonParams,
      },
    },
    async ({ queries, service, ...args }: { queries: string[]; service: string } & RunArgs) =>
      run("search", service, queries, args),
  );

  server.registerTool(
    "get_extraction",
    {
      title: "Get extraction or search by ID",
      description:
        "Retrieve a previous extraction or search by its ID. Works for both extract and search results.",
      inputSchema: {
        id: z.string().describe("The extraction ID (e.g., ext_abc123)."),
      },
    },
    async ({ id }: { id: string }) => ok(await client.getExtraction(id)),
  );

  server.registerTool(
    "get_account",
    {
      title: "Get account balance and usage",
      description:
        "Get your SocialRouter credit balance and a usage summary over the last N days, broken down by provider and platform.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Number of days to summarize (default 30)."),
      },
    },
    async ({ days }: { days?: number }) => {
      const [balance, usage] = await Promise.all([
        client.getBalance(),
        client.getUsage(days),
      ]);
      return ok({ balance, usage });
    },
  );
}

// ─── Start ───────────────────────────────────────────────

async function main() {
  const startup = await catalog.get();
  if (!startup) {
    // No catalog means the API itself is unreachable — nothing would work.
    console.error(
      `[socialrouter-mcp] could not load the service catalog from ${baseUrl} — is the API reachable?`,
    );
    process.exit(1);
  }
  registerTools(startup);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
