import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Research/verification material and build output are not linted. The
    // scripts/ probes are throwaway evidence-gathering, not deliverable code.
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "scripts/**",
      ".venv/**",
      "vitest.config.ts",
      "eslint.config.js",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // design.md §4: checks return CheckResult and never print. Renderers own
      // all output. This makes that architectural rule enforceable rather than
      // aspirational — the renderer files opt back in explicitly.
      "no-console": "error",
    },
  },
  {
    // Renderers are the one layer whose job is writing to stdout/stderr.
    files: ["src/report/**/*.ts", "src/cli.ts"],
    rules: { "no-console": "off" },
  },
);
