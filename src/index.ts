#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap, fail } from "./bootstrap.js";

/*
 * Plumbing only. Everything that can fail, and everything worth asserting,
 * lives in bootstrap.ts — this file runs on import, so it is the one place a
 * test cannot reach.
 */
const server = await bootstrap(process.env, import.meta.url).catch((err: unknown) =>
  fail(err instanceof Error ? err.message : String(err)),
);

await server.connect(new StdioServerTransport());
