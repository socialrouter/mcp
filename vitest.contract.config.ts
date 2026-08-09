import { defineConfig } from "vitest/config";

/**
 * The contract suite: hits the live API, so it is opt-in (`npm run
 * test:contract`) and excluded from the default run, which stays hermetic.
 */
export default defineConfig({
  test: {
    include: ["tests/contract/**/*.test.ts"],
    // A cold API answering the catalogue can take a moment; failing on a slow
    // response would read as drift.
    testTimeout: 30_000,
  },
});
