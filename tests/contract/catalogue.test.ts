import { describe, expect, it } from "vitest";
import { CatalogSnapshot } from "../../src/catalog.js";
import { fingerprint } from "./shape.js";

/**
 * Drift detector, run against the live API rather than a fixture.
 *
 * The MCP redeclares the catalogue's shape locally (src/catalog.ts) instead of
 * importing it, so nothing makes a change upstream a compile error here. This
 * is the substitute: it fails the moment the catalogue gains, loses or
 * conditionalises a field, so the change is a decision someone makes rather
 * than a silence someone discovers in production.
 *
 * On failure, read the diff and pick one:
 *   - the MCP should consume the change  → update src/catalog.ts, then refresh
 *   - the MCP can ignore it              → refresh alone
 * Refresh with: npm run test:contract -- -u
 *
 * Kept out of `npm test` on purpose: it needs the network, and the unit suite
 * has to stay runnable offline and hermetic.
 */

const BASE = (process.env.SOCIALROUTER_BASE_URL ?? "https://api.socialrouter.io").replace(/\/$/, "");

async function catalogue(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/v1/services`);
  if (!res.ok) throw new Error(`GET ${BASE}/v1/services → HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

describe("the live catalogue", () => {
  it("keeps the shape the MCP was written against", async () => {
    const shape = fingerprint(await catalogue());
    await expect(JSON.stringify(shape, null, 2)).toMatchFileSnapshot("./catalogue-shape.json");
  });

  it("is consumable by the snapshot the tools are built from", async () => {
    // The fingerprint pins the shape; this proves the shape is actually
    // usable — every entry survives into a callable row with the fields the
    // run path reads, against real data rather than a fixture we wrote.
    const body = await catalogue();
    const snap = new CatalogSnapshot(
      (body.data as ConstructorParameters<typeof CatalogSnapshot>[0]),
    );

    expect(snap.slugs().length).toBeGreaterThan(0);
    for (const row of snap.services()) {
      expect(row.service, row.service).toBe(`${row.platform}/${row.name}`);
      expect(row.offers.length, row.service).toBeGreaterThan(0);
      expect(Number.isFinite(row.price_from), row.service).toBe(true);
      expect(row.max_inputs, row.service).toBeGreaterThan(0);
      // What INPUT_BODY dispatches on: an unmapped kind sends the inputs
      // under the wrong body field and the API rejects the call.
      expect(["url", "query", "identifier"], row.service).toContain(row.input_kind);
    }
  });
});
