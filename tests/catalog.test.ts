import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogCache, checkService } from "../src/catalog.js";
import { makeSnapshot, RAW_CATALOG } from "./fixtures.js";

describe("CatalogSnapshot", () => {
  const snap = makeSnapshot();

  it("flattens the catalogue into one row per (platform, service)", () => {
    const row = snap.find("reddit/subreddit.posts");
    expect(row).toMatchObject({
      service: "reddit/subreddit.posts",
      platform: "reddit",
      name: "subreddit.posts",
      input_kind: "url",
      price_from: 0.002,
      max_inputs: 100, // the largest cap across offers
    });
    expect(row?.offers.map((o) => o.offer)).toEqual(["apify/harshmaur", "apify/trudax"]);
  });

  it("excludes services no offer serves", () => {
    expect(snap.find("instagram/profile.info")).toBeUndefined();
    expect(snap.slugs()).not.toContain("instagram/profile.info");
  });

  it("keeps the offers in the order the API sent them (failover order)", () => {
    const row = snap.find("linkedin/profile.info");
    expect(row?.offers[0].offer).toBe("brightdata/linkedin");
    expect(row?.price_from).toBe(0.001725);
  });

  it("sorts rows by subject then service name, both namespaces in one list", () => {
    // Flat across namespaces on purpose: this listing is where an agent
    // discovers that person/info exists at all.
    expect(snap.services().map((r) => r.service)).toEqual([
      "googlemaps/place.search",
      "linkedin/profile.info",
      "person/info",
      // The fixture sends user.posts first; within a subject the name decides.
      "reddit/subreddit.posts",
      "reddit/user.posts",
      "youtube/channel.info",
    ]);
  });

  it("defaults the shapes and options the API leaves out", () => {
    // A service declaring neither comes back without the keys at all; the row
    // must still expose arrays, since list_services renders them straight.
    const row = snap.find("reddit/user.posts");
    expect(row?.accepts).toEqual([]);
    expect(row?.options).toEqual([]);
  });

  it("filters services by platform and by service name", () => {
    expect(snap.services({ platform: "youtube" }).every((r) => r.platform === "youtube")).toBe(true);
    expect(snap.services({ service: "profile.info" }).map((r) => r.service)).toEqual([
      "linkedin/profile.info",
    ]);
  });

  it("carries the input kind, accepted shapes and typed options", () => {
    const row = snap.find("linkedin/profile.info");
    expect(row?.accepts).toMatchObject([
      {
        format: "https://www.linkedin.com/in/<handle>",
        example: "https://www.linkedin.com/in/amili",
      },
    ]);
    expect(row?.options.map((o) => o.name)).toEqual(["includeEmail"]);
    expect(snap.find("googlemaps/place.search")?.input_kind).toBe("query");
  });

  it("lists distinct platforms and service names", () => {
    expect(snap.platforms()).toEqual([
      "googlemaps",
      "linkedin",
      "person",
      "reddit",
      "youtube",
    ]);
    expect(snap.names()).toContain("place.search");
  });
});

describe("checkService", () => {
  const snap = makeSnapshot();

  it("accepts a valid service within the batch cap", () => {
    const check = checkService(snap, "linkedin/profile.info", 3);
    expect(check.error).toBeUndefined();
    expect("row" in check && check.row.platform).toBe("linkedin");
  });

  it("suggests the platform's services on an unknown service", () => {
    const check = checkService(snap, "reddit/group.posts", 1);
    expect(check.error).toContain("reddit/subreddit.posts");
  });

  it("falls back to the whole catalogue when the platform is unknown too", () => {
    const check = checkService(snap, "nope/nope", 1);
    expect(check.error).toContain("linkedin/profile.info");
  });

  it("enforces the largest offer cap when the router is free to pick", () => {
    // trudax caps at 10 but harshmaur takes 100 — 50 URLs is fine, the
    // router just drops trudax from the chain.
    expect(checkService(snap, "reddit/subreddit.posts", 50).error).toBeUndefined();
    const tooMany = checkService(snap, "reddit/subreddit.posts", 500);
    expect(tooMany.error).toContain("at most 100 URLs");
    expect(tooMany.error).toContain("received 500");
  });

  it("enforces the pinned offer's own cap", () => {
    const check = checkService(snap, "reddit/subreddit.posts", 50, "apify/trudax");
    expect(check.error).toContain("at most 10 URLs");
    expect(check.error).toContain("omit 'provider'");
  });

  it("rejects an offer that does not serve the service", () => {
    const check = checkService(snap, "reddit/subreddit.posts", 1, "brightdata/reddit");
    expect(check.error).toContain("does not serve");
    expect(check.error).toContain("apify/harshmaur");
  });

  it("names the right unit for query-kind services", () => {
    const check = checkService(snap, "googlemaps/place.search", 500);
    expect(check.error).toContain("at most 100 queries");
  });
});

describe("CatalogCache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubFetch(responses: (() => Promise<Response>)[]): () => number {
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      const next = responses[Math.min(calls, responses.length - 1)];
      calls++;
      return next();
    });
    return () => calls;
  }

  const okResponse = () =>
    Promise.resolve(
      new Response(JSON.stringify({ data: RAW_CATALOG }), { status: 200 }),
    );
  const failResponse = () => Promise.reject(new Error("network down"));

  it("fetches lazily and caches within the TTL", async () => {
    const count = stubFetch([okResponse]);
    const cache = new CatalogCache("https://api.test");
    const first = await cache.get();
    expect(first?.find("reddit/subreddit.posts")).toBeDefined();
    await cache.get();
    await cache.get();
    expect(count()).toBe(1);
  });

  it("coalesces concurrent cold reads into a single fetch", async () => {
    // Every tool call reads the cache. On a cold start the agent can fire
    // several at once, and without the in-flight promise each one would open
    // its own catalogue request.
    const count = stubFetch([okResponse]);
    const cache = new CatalogCache("https://api.test");
    const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(count()).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("retries after a failed refresh instead of latching onto it", async () => {
    // The in-flight promise is cleared in a finally, so a failure must not
    // pin the cache to a permanently rejected fetch.
    const count = stubFetch([failResponse, okResponse]);
    const cache = new CatalogCache("https://api.test");
    expect(await cache.get()).toBeNull();
    expect(await cache.get()).not.toBeNull();
    expect(count()).toBe(2);
  });

  it("refreshes after the TTL and serves stale on failure", async () => {
    vi.useFakeTimers();
    const count = stubFetch([okResponse, failResponse]);
    const cache = new CatalogCache("https://api.test");
    const first = await cache.get();
    expect(first).not.toBeNull();

    vi.advanceTimersByTime(6 * 60_000);
    const second = await cache.get();
    expect(count()).toBe(2); // refresh attempted...
    expect(second).toBe(first); // ...but the stale snapshot is served
  });

  it("returns null when the catalog was never reachable", async () => {
    stubFetch([failResponse]);
    const cache = new CatalogCache("https://api.test");
    expect(await cache.get()).toBeNull();
  });

  it("rejects unexpected payloads", async () => {
    stubFetch([
      () => Promise.resolve(new Response(JSON.stringify({ nope: true }), { status: 200 })),
    ]);
    const cache = new CatalogCache("https://api.test");
    expect(await cache.get()).toBeNull();
  });
});
