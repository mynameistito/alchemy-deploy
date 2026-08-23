import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core, antiSlop],
  ignorePatterns: core.ignorePatterns,
  overrides: [
    {
      files: ["src/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                message: "Use the @/* alias for imports between src modules.",
                regex: "^\\.{1,2}/(?:\\.{1,2}/)?[^./]",
              },
            ],
          },
        ],
      },
    },
  ],
});
