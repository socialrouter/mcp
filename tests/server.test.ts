import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SocialRouter } from "@socialrouter/sdk";
import * as sdk from "@socialrouter/sdk";
import { CatalogCache } from "../src/catalog.js";
import { buildServer, DASHBOARD_KEYS_URL, UNTRUSTED_NOTICE } from "../src/server.js";
import { makeSnapshot, RAW_CATALOG } from "./fixtures.js";

/**
 * End-to-end wiring tests: a real MCP client drives a real McpServer over an
 * in-memory transport, against a real SocialRouter SDK instance. Only `fetch`
 * is stubbed.
 *
 * Using the real SDK is the whole point. v0.7.0 shipped a `run` tool that
 * crashed on every call because the handler held `client.run` detached from
 * its instance, so `this.post()` inside the SDK read off `undefined`. A test
 * that mocked the SDK client would have passed happily; only calling through
 * the real object catches it. Treat "mock the transport, never the SDK" as
 * the rule for this file.
 */

const BASE = "https://api.test";
const EXTRACTION = {
  id: "ext_123",
  status: "completed",
  served_by: "apify/harshmaur",
  records: [{ title: "hello" }],
};

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

let calls: FetchCall[];

/**
 * Route by path: the catalogue plus whatever the test needs on top.
 *
 * `catalogDown` models the API dropping the catalogue while the server is
 * already up — the per-call refresh fails and the handler has to fall back on
 * the snapshot it booted with.
 */
function stubFetch(routes: Record<string, unknown> = {}, catalogDown = false) {
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    const path = url.replace(BASE, "");
    calls.push({
      url: path,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body as string) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    });

    if (path === "/v1/services") {
      return catalogDown
        ? Promise.reject(new Error("network down"))
        : Promise.resolve(new Response(JSON.stringify({ data: RAW_CATALOG }), { status: 200 }));
    }
    const match = Object.keys(routes).find((r) => path.startsWith(r));
    if (match) {
      return Promise.resolve(new Response(JSON.stringify(routes[match]), { status: 200 }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ error: { code: "not_stubbed", message: `no stub for ${path}` } }),
        { status: 500 },
      ),
    );
  });
}

/**
 * Everything the run tool touches, wired the way index.ts wires it.
 *
 * `startup` defaults to the full fixture. Passing a narrower one models a
 * server that booted before the catalogue grew — the tool schemas are frozen
 * at registration while the cache keeps refreshing.
 */
async function connect(startup = makeSnapshot()) {
  const client = new Client({ name: "test", version: "0" });
  const server = buildServer(
    new SocialRouter({ apiKey: "sr_test_key", baseUrl: BASE, client: "mcp" }),
    new CatalogCache(BASE),
    startup,
    "test",
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/**
 * The catalogue still serves (it is public), but every authenticated call
 * comes back 401 — a revoked key, exactly as the API words it.
 */
function stub401() {
  vi.stubGlobal("fetch", (url: string) => {
    const path = url.replace(BASE, "");
    if (path === "/v1/services") {
      return Promise.resolve(new Response(JSON.stringify({ data: RAW_CATALOG }), { status: 200 }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: "invalid_api_key",
            message: "The API key provided is invalid or has been revoked.",
            type: "auth",
          },
        }),
        { status: 401 },
      ),
    );
  });
}

/** The run tool's JSON payload, minus the untrusted-content notice. */
function payload(result: { content: { text: string }[] }) {
  const body = result.content.at(-1)!.text;
  return JSON.parse(body);
}

describe("MCP server wiring", () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("advertises the version it was built with at handshake", async () => {
    stubFetch();
    expect((await connect()).getServerVersion()).toMatchObject({
      name: "socialrouter",
      version: "test",
    });
  });

  it("exposes the four tools", async () => {
    stubFetch();
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_account",
      "get_extraction",
      "list_services",
      "run",
    ]);
  });

  // The v0.7.0 regression: this call reached the SDK and threw before any
  // request left the process.
  it("run reaches the API through the SDK and returns the extraction", async () => {
    stubFetch({ "/v1/extract/reddit/subreddit.posts": EXTRACTION });
    const result = await (await connect()).callTool({
      name: "run",
      arguments: {
        service: "reddit/subreddit.posts",
        inputs: ["https://www.reddit.com/r/programming"],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(payload(result as never)).toMatchObject({ id: "ext_123", served_by: "apify/harshmaur" });

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/v1/extract/reddit/subreddit.posts");
    expect(post.body).toEqual({ urls: ["https://www.reddit.com/r/programming"] });
    expect(post.headers.Authorization).toBe("Bearer sr_test_key");
  });

  it("sends queries, not urls, for a query-kind service", async () => {
    stubFetch({ "/v1/extract/googlemaps/place.search": EXTRACTION });
    await (await connect()).callTool({
      name: "run",
      arguments: { service: "googlemaps/place.search", inputs: ["best pizza in Brooklyn"] },
    });

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ queries: ["best pizza in Brooklyn"] });
  });

  /*
   * The two halves of dispatching an enrichment service, and both used to be
   * wrong: the body field came from a `kind === "query" ? … : …` ternary that
   * sent identifiers as `urls`, and the SDK built every path as
   * `/v1/extract/...`. Either one alone turns a valid call into a 4xx the
   * agent then has to guess its way out of.
   *
   * Gated on the SDK release that carries the fix. This package resolves
   * `@socialrouter/sdk` from npm, not from the sibling folder, so until the
   * new version is published the SDK here still hardcodes `/v1/extract/` and
   * these would fail for a reason that is not the code under test. The probe
   * is a capability check rather than a version range: it flips on its own
   * the moment the dependency is updated, so nobody has to remember to
   * un-skip anything.
   */
  const sdkKnowsNamespaces = "SERVICE_NAMESPACE" in sdk;

  it.skipIf(!sdkKnowsNamespaces)("sends identifiers to the enrich namespace, not urls to extract", async () => {
    stubFetch({ "/v1/enrich/person/info": EXTRACTION });
    const result = await (await connect()).callTool({
      name: "run",
      arguments: { service: "person/info", inputs: ["ada@analytical.dev"] },
    });

    expect(result.isError).toBeFalsy();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/v1/enrich/person/info");
    expect(post.body).toEqual({ identifiers: ["ada@analytical.dev"] });
  });

  it.skipIf(!sdkKnowsNamespaces)("keeps a mixed batch of identifier shapes in one call", async () => {
    // An email and a LinkedIn URL address the same kind of entity; the point
    // of the identifier kind is that they travel together.
    stubFetch({ "/v1/enrich/person/info": EXTRACTION });
    await (await connect()).callTool({
      name: "run",
      arguments: {
        service: "person/info",
        inputs: ["ada@analytical.dev", "https://www.linkedin.com/in/amili"],
      },
    });

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      identifiers: ["ada@analytical.dev", "https://www.linkedin.com/in/amili"],
    });
  });

  it("forwards provider, limit and options untouched", async () => {
    stubFetch({ "/v1/extract/reddit/subreddit.posts": EXTRACTION });
    await (await connect()).callTool({
      name: "run",
      arguments: {
        service: "reddit/subreddit.posts",
        inputs: ["https://www.reddit.com/r/programming"],
        provider: "apify/trudax",
        limit: 5,
        options: { sort: "top" },
      },
    });

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      urls: ["https://www.reddit.com/r/programming"],
      provider: "apify/trudax",
      limit: 5,
      options: { sort: "top" },
    });
  });

  it("marks run results as untrusted third-party content", async () => {
    stubFetch({ "/v1/extract/reddit/subreddit.posts": EXTRACTION });
    const result = await (await connect()).callTool({
      name: "run",
      arguments: {
        service: "reddit/subreddit.posts",
        inputs: ["https://www.reddit.com/r/programming"],
      },
    });
    expect((result.content as { text: string }[])[0].text).toBe(UNTRUSTED_NOTICE);
  });

  it("rejects a bad service before spending a request", async () => {
    stubFetch();
    const result = await (await connect()).callTool({
      name: "run",
      arguments: { service: "reddit/subreddit.posts", inputs: Array(500).fill("https://x.test") },
    });

    expect(result.isError).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("surfaces an API error instead of crashing", async () => {
    stubFetch(); // the run path falls through to the 500 branch
    const result = await (await connect()).callTool({
      name: "run",
      arguments: {
        service: "reddit/subreddit.posts",
        inputs: ["https://www.reddit.com/r/programming"],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0].text;
    // A wiring bug reads off undefined; a real API error names the failure.
    expect(text).not.toContain("Cannot read properties of undefined");
    expect(text).toContain("no stub for /v1/extract/reddit/subreddit.posts");
  });

  /*
   * A rejected key is the one failure the agent cannot route around, and the
   * fix lives in a browser it cannot open. The tool error has to name the
   * dashboard, or the agent retries the call and the user never learns why
   * every SocialRouter tool is failing.
   */
  it("tells the user to create a key when the API rejects theirs", async () => {
    stub401();
    const result = await (await connect()).callTool({
      name: "run",
      arguments: {
        service: "reddit/subreddit.posts",
        inputs: ["https://www.reddit.com/r/programming"],
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toContain("invalid or has been revoked");
    expect(text).toContain(DASHBOARD_KEYS_URL);
    expect(text).toContain("SOCIALROUTER_API_KEY");
  });

  it("carries the same guidance on the account and extraction tools", async () => {
    for (const call of [
      { name: "get_account", arguments: {} },
      { name: "get_extraction", arguments: { id: "ext_123" } },
    ]) {
      stub401();
      const result = await (await connect()).callTool(call);
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain(DASHBOARD_KEYS_URL);
      vi.unstubAllGlobals();
    }
  });

  it("get_extraction fetches by id and marks the result untrusted", async () => {
    stubFetch({ "/v1/extractions/ext_123": EXTRACTION });
    const result = await (await connect()).callTool({
      name: "get_extraction",
      arguments: { id: "ext_123" },
    });

    expect(result.isError).toBeFalsy();
    expect((result.content as { text: string }[])[0].text).toBe(UNTRUSTED_NOTICE);
    expect(calls.some((c) => c.url === "/v1/extractions/ext_123")).toBe(true);
  });

  it("get_account calls balance and usage together", async () => {
    stubFetch({
      "/v1/account/balance": { balance: 9.65, currency: "USD" },
      "/v1/account/usage": { period: "7d", total_requests: 3 },
    });
    const result = await (await connect()).callTool({
      name: "get_account",
      arguments: { days: 7 },
    });

    expect(result.isError).toBeFalsy();
    expect(payload(result as never)).toMatchObject({
      balance: { balance: 9.65 },
      usage: { period: "7d" },
    });
    expect(calls.some((c) => c.url === "/v1/account/usage?days=7")).toBe(true);
  });

  it("rejects an unknown offer before spending a request", async () => {
    stubFetch();
    const result = await (await connect()).callTool({
      name: "run",
      arguments: {
        service: "reddit/subreddit.posts",
        inputs: ["https://www.reddit.com/r/programming"],
        provider: "brightdata/reddit",
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("does not serve");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  /*
   * An unknown slug never reaches checkService: the tool's `service` field is
   * a zod enum of the startup slugs, so the schema rejects it first and the
   * hand-written "Unknown service … Available: …" message in catalog.ts is
   * unreachable from here (it still serves the empty-catalogue fallback,
   * where slugSchema degrades to z.string()). The agent is not left guessing
   * either way — the schema error enumerates the valid slugs — so this pins
   * which of the two paths actually answers.
   */
  it("names the valid slugs when the agent invents one", async () => {
    stubFetch();
    const result = await (await connect()).callTool({
      name: "run",
      arguments: { service: "reddit/nope", inputs: ["https://www.reddit.com/r/x"] },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toContain("reddit/subreddit.posts");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  /*
   * The slug and platform enums are built from the startup snapshot and
   * frozen at registerTool time, while `snap()` re-reads the cache on every
   * call. A service that appears in the catalogue after boot is therefore
   * rejected by the schema before the handler — the MCP has to be restarted
   * to see it. That is the current contract; this pins it so the day it
   * changes is a deliberate one.
   */
  it("refuses a service that was absent from the catalogue at startup", async () => {
    stubFetch({ "/v1/extract/googlemaps/place.search": EXTRACTION });
    const bootedOnReddit = makeSnapshot(RAW_CATALOG.filter((s) => s.platform === "reddit"));

    const result = await (await connect(bootedOnReddit)).callTool({
      name: "run",
      arguments: { service: "googlemaps/place.search", inputs: ["best pizza in Brooklyn"] },
    });

    expect(result.isError).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("get_account fails loudly when one of its two calls fails", async () => {
    // balance answers, usage does not — Promise.all rejects, and the agent
    // must be told rather than handed a half-filled object.
    stubFetch({ "/v1/account/balance": { balance: 9.65, currency: "USD" } });
    const result = await (await connect()).callTool({
      name: "get_account",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).not.toContain("9.65");
  });

  it("get_account omits the window when the agent does not ask for one", async () => {
    // `days` is optional on the tool and defaulted by the SDK; sending
    // `days=undefined` on the wire would make the API parse a bad number.
    stubFetch({
      "/v1/account/balance": { balance: 1, currency: "USD" },
      "/v1/account/usage": { period: "30d" },
    });
    await (await connect()).callTool({ name: "get_account", arguments: {} });

    expect(calls.some((c) => c.url === "/v1/account/usage?days=30")).toBe(true);
  });

  it("list_services serves the catalogue without touching the run path", async () => {
    stubFetch();
    const result = await (await connect()).callTool({
      name: "list_services",
      arguments: { platform: "reddit" },
    });

    expect(payload(result as never)).toMatchObject([
      { service: "reddit/subreddit.posts" },
      { service: "reddit/user.posts" },
    ]);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("list_services lists every callable service, and only those", async () => {
    // instagram/profile.info is declared in the fixture with no offer: nothing
    // serves it, so offering it to the agent would be an invitation to a 4xx.
    stubFetch();
    const result = await (await connect()).callTool({ name: "list_services", arguments: {} });

    const slugs = (payload(result as never) as { service: string }[]).map((r) => r.service);
    expect(slugs).toEqual([
      "googlemaps/place.search",
      "linkedin/profile.info",
      "person/info",
      "reddit/subreddit.posts",
      "reddit/user.posts",
      "youtube/channel.info",
    ]);
  });

  it("list_services filters by service name across subjects", async () => {
    stubFetch();
    const result = await (await connect()).callTool({
      name: "list_services",
      arguments: { service: "profile.info" },
    });

    // linkedin's is served, instagram's is not — the filter must not resurrect it.
    expect((payload(result as never) as { service: string }[]).map((r) => r.service)).toEqual([
      "linkedin/profile.info",
    ]);
  });

  /*
   * A BYOK offer bills nothing through SocialRouter, so it sorts as the
   * cheapest thing on the row — exactly what an agent told to save money will
   * pin. Without `requires_own_key` reaching it, the only signal it gets is
   * `price_per_record: 0`, and the call fails at run time on an account with
   * no key for that source. The flag reaches the agent today only because the
   * offers are passed through by reference; this fails the day a `.map()`
   * normalises them and quietly drops it.
   */
  it("surfaces requires_own_key on the offers it lists", async () => {
    stubFetch();
    const result = await (await connect()).callTool({
      name: "list_services",
      arguments: { platform: "person" },
    });

    expect(payload(result as never)).toMatchObject([
      {
        service: "person/info",
        offers: [{ offer: "apollo/person", price_per_record: 0, requires_own_key: true }],
      },
    ]);
  });

  /*
   * The catalogue is re-read on every call, so a refresh that fails must not
   * take the tools down with it: the server keeps validating against the
   * snapshot it booted with. Without the `?? startup` fallback the API being
   * briefly unreachable would turn every run into a validation error.
   */
  it("keeps serving from the startup catalogue when a refresh fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ "/v1/extract/reddit/subreddit.posts": EXTRACTION }, true);

    const result = await (await connect()).callTool({
      name: "run",
      arguments: {
        service: "reddit/subreddit.posts",
        inputs: ["https://www.reddit.com/r/programming"],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(calls.some((c) => c.url === "/v1/extract/reddit/subreddit.posts")).toBe(true);
  });

  /*
   * The one case where the hand-written "Unknown service" message in
   * catalog.ts answers instead of the zod enum: with no slug to enumerate,
   * `slugSchema` degrades to a free string and validation falls through to
   * checkService, which has no suggestions to offer either. The agent must
   * still be pointed somewhere rather than handed a bare rejection.
   */
  it("stays corrective when it has no catalogue to suggest from", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({}, true);

    const result = await (await connect(makeSnapshot([]))).callTool({
      name: "run",
      arguments: { service: "reddit/subreddit.posts", inputs: ["https://www.reddit.com/r/x"] },
    });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("list_services");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("surfaces a failed get_extraction instead of returning an empty run", async () => {
    // Nothing is stubbed for the id, so the API answers 500: the agent must
    // be told, not handed a result-shaped object it will summarise as empty.
    stubFetch();
    const result = await (await connect()).callTool({
      name: "get_extraction",
      arguments: { id: "ext_unknown" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0].text;
    expect(text).not.toBe(UNTRUSTED_NOTICE);
    expect(text).toContain("ext_unknown");
  });
});
