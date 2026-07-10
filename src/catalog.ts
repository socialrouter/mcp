import type { Platform } from "@socialrouter/sdk";

const CATALOG_TTL_MS = 5 * 60_000;

// Shape of GET /v1/providers (public endpoint, no auth). Only the fields we
// consume are declared; unknown fields are ignored.
interface RawPricingRow {
  type: string;
  platforms: Platform[];
  price_per_record: number;
  max_urls?: number;
  max_queries?: number;
  /** Actor variants — not exposed by the API yet, picked up when it is. */
  variants?: string[];
}

interface RawProvider {
  id: string;
  name: string;
  status: string;
  supported_platforms: Platform[];
  pricing: RawPricingRow[];
  search_pricing?: RawPricingRow[];
}

export type ServiceKind = "extract" | "search";

/** One callable service: a (provider, platform, type) combo live right now. */
export interface ServiceRow {
  /** Slug passed as `service` to the extract/search tools. */
  service: string;
  kind: ServiceKind;
  platform: Platform;
  type: string;
  provider: string;
  status: string;
  price_per_record: number;
  /** Max URLs (extract) or queries (search) accepted per request. */
  max_batch: number;
  variants?: string[];
}

function usable(status: string): boolean {
  return status === "active" || status === "degraded";
}

export class CatalogSnapshot {
  private rows: ServiceRow[] = [];

  constructor(raw: RawProvider[]) {
    for (const p of raw) {
      if (!usable(p.status)) continue;
      const push = (row: RawPricingRow, kind: ServiceKind) => {
        for (const platform of row.platforms) {
          this.rows.push({
            service: `${p.id}/${platform}/${row.type}`,
            kind,
            platform,
            type: row.type,
            provider: p.id,
            status: p.status,
            price_per_record: row.price_per_record,
            max_batch: row.max_urls ?? row.max_queries ?? 1,
            ...(row.variants?.length ? { variants: row.variants } : {}),
          });
        }
      };
      for (const row of p.pricing) push(row, "extract");
      for (const row of p.search_pricing ?? []) push(row, "search");
    }
    // Stable, scannable ordering: platform, then type, then cheapest first.
    this.rows.sort(
      (a, b) =>
        a.platform.localeCompare(b.platform) ||
        a.type.localeCompare(b.type) ||
        a.price_per_record - b.price_per_record,
    );
  }

  services(filter?: { platform?: string; type?: string }): ServiceRow[] {
    return this.rows.filter(
      (r) =>
        (!filter?.platform || r.platform === filter.platform) &&
        (!filter?.type || r.type === filter.type),
    );
  }

  find(service: string): ServiceRow | undefined {
    return this.rows.find((r) => r.service === service);
  }

  slugs(kind: ServiceKind): string[] {
    return this.rows.filter((r) => r.kind === kind).map((r) => r.service);
  }

  platforms(): Platform[] {
    return [...new Set(this.rows.map((r) => r.platform))].sort();
  }

  types(): string[] {
    return [...new Set(this.rows.map((r) => r.type))].sort();
  }
}

export type ServiceCheck = { row: ServiceRow; error?: never } | { error: string };

/**
 * Validate a service slug against the catalog before spending an API
 * round-trip: the slug must exist (a `:variant` suffix is ignored for the
 * lookup), belong to the right kind of tool, and accept the batch size.
 * Errors are corrective — they list the closest valid alternatives.
 */
export function checkService(
  snap: CatalogSnapshot,
  kind: ServiceKind,
  service: string,
  batchSize: number,
): ServiceCheck {
  const base = service.split(":")[0];
  const row = snap.find(base);
  if (!row) {
    const [, platform, type] = base.split("/");
    const sameCombo = snap.services({ platform, type });
    const samePlatform = snap.services({ platform });
    const suggestions = (sameCombo.length ? sameCombo : samePlatform)
      .filter((r) => r.kind === kind)
      .map((r) => r.service)
      .slice(0, 8);
    return {
      error:
        `Unknown service "${service}".` +
        (suggestions.length
          ? ` Available: ${suggestions.join(", ")}.`
          : " Call list_services to see what is available."),
    };
  }
  if (row.kind !== kind) {
    return {
      error: `"${base}" is a ${row.kind} service — call the "${row.kind}" tool instead.`,
    };
  }
  if (batchSize > row.max_batch) {
    const one = kind === "search" ? "query" : "URL";
    const many = kind === "search" ? "queries" : "URLs";
    return {
      error:
        `"${base}" accepts at most ${row.max_batch} ${row.max_batch === 1 ? one : many} per request; received ${batchSize}. ` +
        "Send smaller batches or pick a provider with a higher cap (see list_services).",
    };
  }
  return { row };
}

/**
 * TTL-cached provider catalog. Fetched once at startup (the server refuses to
 * boot without it — no catalog means the API itself is unreachable) and
 * refreshed lazily afterwards; on refresh failure the stale snapshot is
 * served.
 */
export class CatalogCache {
  private snapshot: CatalogSnapshot | null = null;
  private fetchedAt = 0;
  private inflight: Promise<CatalogSnapshot | null> | null = null;

  constructor(private baseUrl: string) {}

  async get(): Promise<CatalogSnapshot | null> {
    if (this.snapshot && Date.now() - this.fetchedAt < CATALOG_TTL_MS) {
      return this.snapshot;
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<CatalogSnapshot | null> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/providers`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: RawProvider[] };
      if (!Array.isArray(json.data)) throw new Error("unexpected payload");
      this.snapshot = new CatalogSnapshot(json.data);
      this.fetchedAt = Date.now();
    } catch (err) {
      console.error(`[socialrouter-mcp] catalog refresh failed: ${err}`);
      // Keep serving the stale snapshot (or null if none yet).
    }
    return this.snapshot;
  }
}
