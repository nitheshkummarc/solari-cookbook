import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],

    // design.md §10/§11: unit tests never touch live Solari services. The live
    // integration run is a separate, manually triggered workflow — it must not
    // be reachable from `npm test`.
    exclude: ["node_modules/**", "dist/**", "scripts/**", ".venv/**"],

    // Foundations land before any test does. This keeps the build green and
    // honest ("no tests yet") rather than red, and must be revisited once the
    // first real test exists — a suite that silently passes with zero tests is
    // a hazard later.
    passWithNoTests: true,

    environment: "node",
    restoreMocks: true,
  },
});
