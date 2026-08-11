import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SocialRouter } from "@socialrouter/sdk";
import { CatalogCache } from "./catalog.js";
import { buildServer, DASHBOARD_KEYS_URL } from "./server.js";

export const DEFAULT_BASE_URL = "https://api.socialrouter.io";

/**
 * Everything the entry point does apart from attaching stdio, kept here so it
 * is reachable from a test: importing `index.ts` runs it, which is exactly the
 * shape no test can drive.
 *
 * Failures are thrown rather than exited on, so the caller owns the process
 * and the messages can be asserted.
 */

/**
 * The published version, read from package.json rather than hardcoded so
 * `npm version` is the only place a release touches.
 *
 * `moduleUrl` is the caller's own `import.meta.url`: package.json sits one
 * level up from the built entry point, and npm always ships it in the tarball.
 * Taking it as an argument rather than reading `import.meta.url` directly lets
 * the test resolve from the path `bin` actually publishes — the resolution is
 * coupled to the compiler's output layout, and a `rootDir` change that buried
 * the entry one level deeper would otherwise only surface as an ENOENT on a
 * user's first launch.
 */
export function readVersion(moduleUrl: string): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", moduleUrl), "utf8"),
  ) as { version: string };
  return pkg.version;
}

/** Trailing slash stripped: the SDK and the catalogue both append absolute paths. */
export function resolveBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.SOCIALROUTER_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

/**
 * Build the server, or throw with the message the user needs to fix it.
 * Returns it unconnected — the transport is the entry point's business.
 */
export async function bootstrap(
  env: NodeJS.ProcessEnv,
  moduleUrl: string,
): Promise<McpServer> {
  const apiKey = env.SOCIALROUTER_API_KEY;
  if (!apiKey) {
    // Stderr on a stdio server is often all the user ever sees, so it carries
    // the fix as well as the diagnosis.
    throw new Error(
      "SOCIALROUTER_API_KEY environment variable is required. " +
        `Create an API key at ${DASHBOARD_KEYS_URL} and set it in this MCP server's configuration.`,
    );
  }

  const baseUrl = resolveBaseUrl(env);
  const client = new SocialRouter({ apiKey, baseUrl, client: "mcp" });
  const catalog = new CatalogCache(baseUrl);

  const startup = await catalog.get();
  if (!startup) {
    // No catalog means the API itself is unreachable — nothing would work.
    throw new Error(
      `[socialrouter-mcp] could not load the service catalog from ${baseUrl} — is the API reachable?`,
    );
  }

  return buildServer(client, catalog, startup, readVersion(moduleUrl));
}

/** Report a fatal startup problem the way a stdio host reads it: stderr, exit 1. */
export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
