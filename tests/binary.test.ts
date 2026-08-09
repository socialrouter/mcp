import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RAW_CATALOG } from "./fixtures.js";

/**
 * The shipped binary, launched the way a host launches it: a real process,
 * real stdio, real network. Everything else in this suite imports modules —
 * only this proves the artifact npm publishes actually starts.
 *
 * It is the one thing the in-process tests structurally cannot cover: the
 * shebang, the built entry's own path resolution (`../package.json` from
 * `dist/`), and the stdio transport. `src/index.ts` is deliberately kept to
 * plumbing for that reason — anything that can fail lives in bootstrap.ts,
 * where it can be driven directly.
 */

const ENTRY = new URL("../dist/index.js", import.meta.url).pathname;
const PKG = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

let api: Server;
let baseUrl: string;

beforeAll(async () => {
  if (!existsSync(ENTRY)) {
    throw new Error(`${ENTRY} is missing — run \`npm run build\` before the tests.`);
  }
  api = createServer((req, res) => {
    if (req.url === "/v1/services") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: RAW_CATALOG }));
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => api.close(resolve));
});

/** Launch the binary and run it to completion, capturing what a host sees. */
function launch(env: Record<string, string>) {
  return new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

describe("the published binary", () => {
  it("serves MCP over stdio, at the version in package.json", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [ENTRY],
        env: { PATH: process.env.PATH ?? "", SOCIALROUTER_API_KEY: "sr_test", SOCIALROUTER_BASE_URL: baseUrl },
      }),
    );

    try {
      // The version comes off disk in the built layout — the assertion the
      // in-process tests can only approximate.
      expect(client.getServerVersion()).toMatchObject({
        name: "socialrouter",
        version: PKG.version,
      });
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "get_account",
        "get_extraction",
        "list_services",
        "run",
      ]);
    } finally {
      await client.close();
    }
  });

  it("exits 1 with a usable message when the key is missing", async () => {
    const { code, stderr } = await launch({ SOCIALROUTER_BASE_URL: baseUrl });
    expect(code).toBe(1);
    expect(stderr).toContain("SOCIALROUTER_API_KEY environment variable is required");
  });

  it("exits 1 naming the host when the catalogue is unreachable", async () => {
    // Port 1 refuses instantly: an API that is down, not slow.
    const { code, stderr } = await launch({
      SOCIALROUTER_API_KEY: "sr_test",
      SOCIALROUTER_BASE_URL: "http://127.0.0.1:1",
    });
    expect(code).toBe(1);
    expect(stderr).toContain("could not load the service catalog from http://127.0.0.1:1");
  });
});
