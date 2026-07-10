import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogCache, checkService } from "../src/catalog.js";
import { makeSnapshot, RAW_CATALOG } from "./fixtures.js";

describe("CatalogSnapshot", () => {
  const snap = makeSnapshot();

  it("flattens the catalog into one row per (provider, platform, type)", () => {
    const row = snap.find("brightdata/linkedin/profile.info");
    expect(row).toMatchObject({
      service: "brightdata/linkedin/profile.info",
      kind: "extract",
      platform: "linkedin",
      type: "profile.info",
      provider: "brightdata",
      status: "active",
      price_per_record: 0.001725,
      max_batch: 1000,
    });
  });

  it("excludes non-usable providers", () => {
    expect(snap.find("downprov/linkedin/profile.info")).toBeUndefined();
    expect(snap.services().map((r) => r.provider)).not.toContain("downprov");
  });

  it("includes degraded providers", () => {
    const degraded = makeSnapshot([{ ...RAW_CATALOG[0], status: "degraded" }]);
    expect(degraded.find("apify/linkedin/profile.info")?.status).toBe("degraded");
  });

  it("sorts rows by platform, type, then cheapest first", () => {
    const linkedinProfile = snap.services({
      platform: "linkedin",
      type: "profile.info",
    });
    expect(linkedinProfile.map((r) => r.provider)).toEqual(["brightdata", "apify"]);
  });

  it("filters services by platform and type", () => {
    expect(snap.services({ platform: "youtube" }).every((r) => r.platform === "youtube")).toBe(true);
    expect(snap.services({ type: "profile.info" }).map((r) => r.service)).toEqual([
      "brightdata/instagram/profile.info",
      "brightdata/linkedin/profile.info",
      "apify/linkedin/profile.info",
    ]);
  });

  it("separates search slugs from extract slugs", () => {
    expect(snap.slugs("search")).toEqual(["apify/googlemaps/place.search"]);
    expect(snap.slugs("extract")).not.toContain("apify/googlemaps/place.search");
    expect(snap.find("apify/googlemaps/place.search")?.max_batch).toBe(100); // from max_queries
  });

  it("lists distinct platforms and types", () => {
    expect(snap.platforms()).toContain("googlemaps");
    expect(snap.types()).toContain("place.search");
  });

  it("passes variants through when present", () => {
    const withVariants = makeSnapshot([
      {
        ...RAW_CATALOG[0],
        pricing: [
          {
            type: "profile.info",
            platforms: ["linkedin"],
            price_per_record: 0.0069,
            max_urls: 1,
            variants: ["apimaestro"],
          },
        ],
      },
    ]);
    expect(withVariants.find("apify/linkedin/profile.info")?.variants).toEqual([
      "apimaestro",
    ]);
  });
});

describe("checkService", () => {
  const snap = makeSnapshot();

  it("accepts a valid slug within the batch cap", () => {
    const check = checkService(snap, "extract", "brightdata/linkedin/profile.info", 3);
    expect(check.error).toBeUndefined();
    expect("row" in check && check.row.provider).toBe("brightdata");
  });

  it("ignores a :variant suffix for the lookup", () => {
    const check = checkService(
      snap,
      "extract",
      "apify/linkedin/profile.info:apimaestro",
      1,
    );
    expect(check.error).toBeUndefined();
  });

  it("suggests other providers of the same platform/type on unknown slug", () => {
    const check = checkService(snap, "extract", "nope/linkedin/profile.info", 1);
    expect(check.error).toContain("brightdata/linkedin/profile.info");
    expect(check.error).toContain("apify/linkedin/profile.info");
  });

  it("falls back to same-platform suggestions when the type is unknown", () => {
    const check = checkService(snap, "extract", "apify/youtube/nope.info", 1);
    expect(check.error).toContain("apify/youtube/channel.info");
  });

  it("points to list_services when nothing matches", () => {
    const check = checkService(snap, "extract", "nope/nope/nope", 1);
    expect(check.error).toContain("list_services");
  });

  it("rejects a search slug passed to extract, and vice versa", () => {
    expect(
      checkService(snap, "extract", "apify/googlemaps/place.search", 1).error,
    ).toContain('call the "search" tool');
    expect(
      checkService(snap, "search", "brightdata/linkedin/profile.info", 1).error,
    ).toContain('call the "extract" tool');
  });

  it("enforces the provider batch cap before the API call", () => {
    const check = checkService(snap, "extract", "apify/linkedin/profile.info", 2);
    expect(check.error).toContain("at most 1 URL");
    expect(check.error).toContain("received 2");
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
    expect(first?.find("apify/linkedin/profile.info")).toBeDefined();
    await cache.get();
    await cache.get();
    expect(count()).toBe(1);
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
