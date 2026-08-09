import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The contract suite talks to the live API — opt in with
    // `npm run test:contract`. The default run stays offline-safe.
    exclude: ["node_modules/**", "dist/**", "tests/contract/**"],
  },
});
