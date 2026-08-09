/**
 * A structural fingerprint of GET /v1/services.
 *
 * The point is to notice the catalogue changing *shape* — a field appearing,
 * disappearing, or becoming conditional; a new input kind; a new option type —
 * without firing every time a service or a platform is added. Those happen
 * weekly and need no change here: the tool schemas are built from the
 * catalogue at runtime, so the MCP picks them up on its own. Fingerprinting
 * content instead of shape would cry wolf until nobody read it.
 *
 * What *does* need a code change is exactly what this records.
 */

export interface KeyShape {
  /** Keys present on every object at this level — safe to read unguarded. */
  always: string[];
  /** Keys present on some only — must be treated as optional. */
  sometimes: string[];
}

export interface CatalogueShape {
  envelope: string[];
  service: KeyShape;
  offer: KeyShape;
  accepts: KeyShape;
  option: KeyShape;
  /** Drives INPUT_BODY in server.ts and INPUT_UNIT in catalog.ts. */
  input_kind: string[];
  /** The body field each kind maps to. */
  input_field: string[];
  /** Drives the ServiceOption.type union. */
  option_type: string[];
}

function keyShape(objects: Record<string, unknown>[]): KeyShape {
  const counts = new Map<string, number>();
  for (const o of objects) {
    for (const k of Object.keys(o)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const always: string[] = [];
  const sometimes: string[] = [];
  for (const [key, seen] of counts) {
    (seen === objects.length ? always : sometimes).push(key);
  }
  return { always: always.sort(), sometimes: sometimes.sort() };
}

const distinct = (values: unknown[]): string[] =>
  [...new Set(values.map(String))].sort();

export function fingerprint(body: Record<string, unknown>): CatalogueShape {
  const services = body.data as Record<string, unknown>[];
  const nested = (key: string) =>
    services.flatMap((s) => (s[key] as Record<string, unknown>[] | undefined) ?? []);

  return {
    envelope: Object.keys(body).sort(),
    service: keyShape(services),
    offer: keyShape(nested("offers")),
    accepts: keyShape(nested("accepts")),
    option: keyShape(nested("options")),
    input_kind: distinct(services.map((s) => s.input_kind)),
    input_field: distinct(services.map((s) => s.input_field)),
    option_type: distinct(nested("options").map((o) => o.type)),
  };
}
