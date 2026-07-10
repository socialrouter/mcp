import { CatalogSnapshot } from "../src/catalog.js";

/**
 * Small but realistic catalog: two usable providers with overlapping combos
 * (to exercise cheapest-first ordering) and one down provider (to exercise
 * status filtering). Prices mirror the live catalog's ordering on linkedin
 * profile.info: brightdata < apify.
 */
export const RAW_CATALOG = [
  {
    id: "apify",
    name: "Apify",
    status: "active",
    supported_platforms: ["linkedin", "googlemaps", "youtube"],
    pricing: [
      { type: "profile.info", platforms: ["linkedin"], price_per_record: 0.0069, max_urls: 1 },
      { type: "profile.posts", platforms: ["linkedin", "youtube"], price_per_record: 0.00552, max_urls: 100 },
      { type: "profile.shorts", platforms: ["youtube"], price_per_record: 0.00552, max_urls: 100 },
      { type: "video.transcript", platforms: ["youtube"], price_per_record: 0.00552, max_urls: 100 },
      { type: "channel.info", platforms: ["youtube"], price_per_record: 0.00552, max_urls: 100 },
    ],
    search_pricing: [
      { type: "place.search", platforms: ["googlemaps"], price_per_record: 0.00552, max_queries: 100 },
    ],
  },
  {
    id: "brightdata",
    name: "Bright Data",
    status: "active",
    supported_platforms: ["linkedin", "instagram", "facebook", "x", "tiktok"],
    pricing: [
      { type: "profile.info", platforms: ["linkedin", "instagram"], price_per_record: 0.001725, max_urls: 1000 },
      { type: "profile.reels", platforms: ["instagram", "facebook"], price_per_record: 0.002, max_urls: 20 },
      { type: "post.info", platforms: ["x", "tiktok"], price_per_record: 0.002, max_urls: 50 },
    ],
  },
  {
    id: "downprov",
    name: "Down Provider",
    status: "down",
    supported_platforms: ["linkedin"],
    pricing: [
      { type: "profile.info", platforms: ["linkedin"], price_per_record: 0.0001, max_urls: 10 },
    ],
  },
];

export function makeSnapshot(raw: unknown[] = RAW_CATALOG): CatalogSnapshot {
  return new CatalogSnapshot(raw as ConstructorParameters<typeof CatalogSnapshot>[0]);
}
