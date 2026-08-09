import { describe, expect, it } from "vitest";
import { fingerprint } from "./contract/shape.js";

/**
 * The drift detector's own logic, checked offline. The contract test that uses
 * it only ever sees one catalogue — a fingerprint that quietly failed to
 * notice a change would look exactly like an API that never changed.
 */

const entry = (over: Record<string, unknown> = {}) => ({
  platform: "reddit",
  service: "subreddit.posts",
  endpoint: "/v1/extract/reddit/subreddit.posts",
  input_kind: "url",
  input_field: "urls",
  accepts: [{ format: "f", example: "e" }],
  options: [],
  offers: [
    { offer: "apify/harshmaur", source: "apify", price_per_record: 0.002, max_inputs: 100, requires_own_key: false },
  ],
  ...over,
});

describe("fingerprint", () => {
  it("separates keys present everywhere from keys present on some", () => {
    const shape = fingerprint({ data: [entry(), entry({ deprecated_at: "2026-01-01" })] });
    expect(shape.service.always).toContain("platform");
    expect(shape.service.sometimes).toEqual(["deprecated_at"]);
  });

  it("notices a field added to every entry", () => {
    const before = fingerprint({ data: [entry()] });
    const after = fingerprint({ data: [entry({ beta: true })] });
    expect(after.service.always).not.toEqual(before.service.always);
    expect(after.service.always).toContain("beta");
  });

  it("notices a field dropped from a nested object", () => {
    const shape = fingerprint({
      data: [entry({ offers: [{ offer: "apify/x", source: "apify", price_per_record: 1, max_inputs: 1 }] })],
    });
    expect(shape.offer.always).not.toContain("requires_own_key");
  });

  it("notices a field becoming conditional", () => {
    // The dangerous half: `requires_own_key` on every offer means it can be
    // read unguarded. The day one offer omits it, the flag reads as falsy —
    // a BYOK offer silently presented as free.
    const shape = fingerprint({
      data: [
        entry(),
        entry({ offers: [{ offer: "apify/y", source: "apify", price_per_record: 1, max_inputs: 1 }] }),
      ],
    });
    expect(shape.offer.always).not.toContain("requires_own_key");
    expect(shape.offer.sometimes).toContain("requires_own_key");
  });

  it("notices a new input kind, option type and envelope key", () => {
    // A kind absent from INPUT_BODY sends the inputs under the wrong body
    // field; an option type absent from the union is rendered untyped.
    const shape = fingerprint({
      data: [entry({ input_kind: "handle", input_field: "handles", options: [{ name: "n", type: "array", description: "d" }] })],
      meta: { total: 1 },
    });
    expect(shape.input_kind).toEqual(["handle"]);
    expect(shape.input_field).toEqual(["handles"]);
    expect(shape.option_type).toEqual(["array"]);
    expect(shape.envelope).toEqual(["data", "meta"]);
  });
});
