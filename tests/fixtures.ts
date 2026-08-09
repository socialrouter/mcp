import { CatalogSnapshot } from "../src/catalog.js";

/**
 * Small but realistic slice of GET /v1/services: services with several
 * offers (to exercise failover ordering and per-offer caps), a query-kind
 * service, services with typed options, and one entry with no offer at all
 * (declared but unserved — it must not surface as callable).
 */
export const RAW_CATALOG = [
  {
    platform: "linkedin",
    service: "profile.info",
    endpoint: "/v1/extract/linkedin/profile.info",
    input_kind: "url",
    input_field: "urls",
    accepts: [
      {
        format: "https://www.linkedin.com/in/<handle>",
        example: "https://www.linkedin.com/in/amili",
        pattern: "linkedin\\.com\\/in\\/[^\\/?#]+",
      },
    ],
    options: [
      {
        name: "includeEmail",
        type: "boolean",
        default: true,
        description: "Include the public email lookup when the offer supports it.",
      },
    ],
    offers: [
      { offer: "brightdata/linkedin", source: "brightdata", price_per_record: 0.001725, max_inputs: 1000 },
      { offer: "apify/apimaestro", source: "apify", price_per_record: 0.0069, max_inputs: 1 },
    ],
  },
  {
    platform: "reddit",
    service: "subreddit.posts",
    endpoint: "/v1/extract/reddit/subreddit.posts",
    input_kind: "url",
    input_field: "urls",
    accepts: [
      {
        format: "https://www.reddit.com/r/<subreddit>",
        example: "https://www.reddit.com/r/programming",
        pattern: "reddit\\.com\\/r\\/[^\\/?#]+",
      },
    ],
    options: [
      {
        name: "sort",
        type: "enum",
        values: ["hot", "new", "top", "rising"],
        description: "Listing sort.",
      },
    ],
    offers: [
      { offer: "apify/harshmaur", source: "apify", price_per_record: 0.002, max_inputs: 100 },
      { offer: "apify/trudax", source: "apify", price_per_record: 0.0035, max_inputs: 10 },
    ],
  },
  {
    // Second service on a platform that already has one, and listed here out
    // of alphabetical order: without it nothing exercises the tie-break on
    // service name. `accepts` and `options` are absent rather than empty —
    // the API omits them on a service that declares neither, and the snapshot
    // has to default them instead of handing the agent `undefined`.
    platform: "reddit",
    service: "user.posts",
    endpoint: "/v1/extract/reddit/user.posts",
    input_kind: "url",
    input_field: "urls",
    offers: [
      { offer: "apify/trudax", source: "apify", price_per_record: 0.0035, max_inputs: 10, requires_own_key: false },
    ],
  },
  {
    platform: "youtube",
    service: "channel.info",
    endpoint: "/v1/extract/youtube/channel.info",
    input_kind: "url",
    input_field: "urls",
    accepts: [
      {
        format: "https://www.youtube.com/@<handle>",
        example: "https://www.youtube.com/@mkbhd",
        pattern: "youtube\\.com\\/@[^\\/?#]+",
      },
    ],
    options: [],
    offers: [
      { offer: "apify/streamers", source: "apify", price_per_record: 0.00552, max_inputs: 100 },
    ],
  },
  {
    platform: "googlemaps",
    service: "place.search",
    endpoint: "/v1/extract/googlemaps/place.search",
    input_kind: "query",
    input_field: "queries",
    accepts: [
      { format: "Free-text search query", example: "best pizza in Brooklyn, NY" },
    ],
    options: [],
    offers: [
      { offer: "apify/compass", source: "apify", price_per_record: 0.00552, max_inputs: 100 },
    ],
  },
  {
    // An enrichment service: the other namespace, the identifier input kind,
    // and a BYOK-only offer — the three things a platform-only fixture never
    // exercises. Its endpoint is under /v1/enrich, which is where the run
    // tool must send it.
    platform: "person",
    service: "info",
    endpoint: "/v1/enrich/person/info",
    input_kind: "identifier",
    input_field: "identifiers",
    accepts: [
      { format: "<email>", example: "ada@analytical.dev" },
      {
        format: "https://www.linkedin.com/in/<handle>",
        example: "https://www.linkedin.com/in/amili",
        pattern: "linkedin\\.com\\/in\\/[^\\/?#]+",
      },
    ],
    options: [
      {
        name: "enrich",
        type: "boolean",
        default: true,
        description: "Resolve each hit into a full profile.",
      },
    ],
    offers: [
      {
        offer: "apollo/person",
        source: "apollo",
        price_per_record: 0,
        max_inputs: 10,
        requires_own_key: true,
      },
    ],
  },
  {
    // Declared but served by nobody: must never surface as callable.
    platform: "instagram",
    service: "profile.info",
    endpoint: "/v1/extract/instagram/profile.info",
    input_kind: "url",
    input_field: "urls",
    accepts: [],
    options: [],
    offers: [],
  },
];

export function makeSnapshot(raw: unknown[] = RAW_CATALOG): CatalogSnapshot {
  return new CatalogSnapshot(raw as ConstructorParameters<typeof CatalogSnapshot>[0]);
}
