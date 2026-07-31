import type { Platform } from "@socialrouter/sdk";

const CATALOG_TTL_MS = 5 * 60_000;

// Shape of GET /v1/services (public endpoint, no auth): the service-first
// catalogue, one entry per callable (platform, service) with its offers in
// failover order. Only the fields we consume are declared; unknown fields
// are ignored.

/** One accepted input shape of a service. */
export interface InputFormat {
  /** Canonical shape, e.g. "https://www.linkedin.com/in/<handle>". */
  format: string;
  /** A concrete valid input. */
  example: string;
  /** Validation regex source — informational; the API validates, not us. */
  pattern?: string;
  note?: string;
}

/** One typed option a service accepts. */
export interface ServiceOption {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  values?: string[];
  format?: string;
  description: string;
  default?: string | number | boolean;
}

/** One offer of a service: a source's concrete implementation of it. */
export interface CatalogueOffer {
  /** Public offer id, e.g. "apify/harshmaur". */
  offer: string;
  source: string;
  price_per_record: number;
  /** Max inputs this offer accepts per request. */
  max_inputs: number;
}

interface RawService {
  platform: Platform;
  service: string;
  endpoint: string;
  input_kind: "url" | "query";
  input_field: "urls" | "queries";
  accepts: InputFormat[];
  options: ServiceOption[];
  offers: CatalogueOffer[];
}

/** One callable service, as surfaced to the agent. */
export interface ServiceRow {
  /** Slug passed as `service` to the run tool, e.g. "reddit/subreddit.posts". */
  service: string;
  platform: Platform;
  /** The service half of the slug, e.g. "subreddit.posts". */
  name: string;
  /** What the service consumes: a URL per record, or a free-text query. */
  input_kind: "url" | "query";
  /**
   * Accepted input shape(s). Display-only: the API is the validation
   * authority and returns the corrective error itself.
   */
  accepts: InputFormat[];
  /** Typed options this service takes. Empty when none. */
  options: ServiceOption[];
  /** Offers in failover order — the head serves unless one is pinned. */
  offers: CatalogueOffer[];
  /** Cheapest offer price per record. */
  price_from: number;
  /** Largest batch any offer of this service accepts. */
  max_inputs: number;
}

export class CatalogSnapshot {
  private rows: ServiceRow[] = [];

  constructor(raw: RawService[]) {
    for (const s of raw) {
      if (!s.offers?.length) continue;
      this.rows.push({
        service: `${s.platform}/${s.service}`,
        platform: s.platform,
        name: s.service,
        input_kind: s.input_kind,
        accepts: s.accepts ?? [],
        options: s.options ?? [],
        offers: s.offers,
        price_from: Math.min(...s.offers.map((o) => o.price_per_record)),
        max_inputs: Math.max(...s.offers.map((o) => o.max_inputs)),
      });
    }
    // Stable, scannable ordering: platform, then service name.
    this.rows.sort(
      (a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name),
    );
  }

  services(filter?: { platform?: string; service?: string }): ServiceRow[] {
    return this.rows.filter(
      (r) =>
        (!filter?.platform || r.platform === filter.platform) &&
        (!filter?.service || r.name === filter.service),
    );
  }

  find(service: string): ServiceRow | undefined {
    return this.rows.find((r) => r.service === service);
  }

  slugs(): string[] {
    return this.rows.map((r) => r.service);
  }

  platforms(): Platform[] {
    return [...new Set(this.rows.map((r) => r.platform))].sort();
  }

  /** Distinct service names across platforms, for the list filter. */
  names(): string[] {
    return [...new Set(this.rows.map((r) => r.name))].sort();
  }
}

export type ServiceCheck = { row: ServiceRow; error?: never } | { error: string };

/**
 * Validate a run against the catalog before spending an API round-trip: the
 * service must exist, the pinned offer (if any) must serve it, and the batch
 * must fit. Errors are corrective — they name the valid alternatives, since
 * the reader is an agent that has to fix its own call.
 */
export function checkService(
  snap: CatalogSnapshot,
  service: string,
  inputCount: number,
  provider?: string,
): ServiceCheck {
  const row = snap.find(service);
  if (!row) {
    const [platform] = service.split("/");
    const samePlatform = snap.services({ platform });
    const suggestions = (samePlatform.length ? samePlatform : snap.services())
      .map((r) => r.service)
      .slice(0, 12);
    return {
      error:
        `Unknown service "${service}".` +
        (suggestions.length
          ? ` Available: ${suggestions.join(", ")}.`
          : " Call list_services to see what is available."),
    };
  }

  if (provider) {
    const offer = row.offers.find((o) => o.offer === provider);
    if (!offer) {
      return {
        error:
          `Offer "${provider}" does not serve "${service}". Offers: ${row.offers
            .map((o) => o.offer)
            .join(", ")}. Omit 'provider' to let the router pick and fail over.`,
      };
    }
    if (inputCount > offer.max_inputs) {
      const unit = row.input_kind === "query" ? "queries" : "URLs";
      return {
        error:
          `Offer "${provider}" accepts at most ${offer.max_inputs} ${unit} per request; received ${inputCount}. ` +
          "Send smaller batches, or omit 'provider' so the router picks an offer with a large enough cap.",
      };
    }
    return { row };
  }

  if (inputCount > row.max_inputs) {
    const unit = row.input_kind === "query" ? "queries" : "URLs";
    return {
      error:
        `"${service}" accepts at most ${row.max_inputs} ${unit} per request; received ${inputCount}. ` +
        "Send smaller batches.",
    };
  }
  return { row };
}

/**
 * TTL-cached service catalog. Fetched once at startup (the server refuses to
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
      const res = await fetch(`${this.baseUrl}/v1/services`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: RawService[] };
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
