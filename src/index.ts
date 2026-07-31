#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SocialRouter } from "@socialrouter/sdk";
import { CatalogCache } from "./catalog.js";
import { buildServer } from "./server.js";

const DEFAULT_BASE_URL = "https://api.socialrouter.io";

/**
 * Read from package.json rather than hardcoded, so `npm version` is the only
 * place a release touches. Resolves to the package root from dist/index.js,
 * and npm always ships package.json in the tarball.
 */
const VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

async function main() {
  const apiKey = process.env.SOCIALROUTER_API_KEY;
  if (!apiKey) {
    console.error("SOCIALROUTER_API_KEY environment variable is required");
    process.exit(1);
  }

  const baseUrl = (process.env.SOCIALROUTER_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const client = new SocialRouter({ apiKey, baseUrl, client: "mcp" });
  const catalog = new CatalogCache(baseUrl);

  const startup = await catalog.get();
  if (!startup) {
    // No catalog means the API itself is unreachable — nothing would work.
    console.error(
      `[socialrouter-mcp] could not load the service catalog from ${baseUrl} — is the API reachable?`,
    );
    process.exit(1);
  }

  const server = buildServer(client, catalog, startup, VERSION);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
