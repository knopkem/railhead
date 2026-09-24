import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The bench fixtures are driven by their own `node --test` runs (see
    // scripts/bench.mts); vitest must not collect them as part of npm test.
    exclude: [...configDefaults.exclude, "scripts/fixtures/**"],
  },
});
