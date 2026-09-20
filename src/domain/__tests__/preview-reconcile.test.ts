import { describe, expect, test } from "bun:test";

import { previewCandidates } from "@/domain/preview-reconcile.ts";

const sha = (digit: string): string => digit.repeat(40);

describe("preview reconcile candidates", () => {
  test("keeps one entry per preview stage in newest-first order", () => {
    const candidates = previewCandidates([
      { environment: "pr-103", sha: sha("a") },
      { environment: "pr-103", sha: sha("b") },
      { environment: "production", sha: sha("c") },
      { environment: "pr-100", sha: sha("d") },
    ]);

    expect(candidates).toEqual([
      { pullRequest: 103, sha: sha("a"), stage: "pr-103" },
      { pullRequest: 100, sha: sha("d"), stage: "pr-100" },
    ]);
  });

  test("ignores non-preview deployment environments", () => {
    const candidates = previewCandidates([
      { environment: "prod", sha: sha("a") },
      { environment: "preview", sha: sha("b") },
      { environment: "pr-", sha: sha("c") },
      { environment: "pr-x", sha: sha("d") },
      { environment: "pr-0", sha: sha("e") },
      { environment: "pr-1", sha: sha("f") },
    ]);

    expect(candidates).toEqual([
      { pullRequest: 1, sha: sha("f"), stage: "pr-1" },
    ]);
  });

  test("returns nothing without deployment records", () => {
    expect(previewCandidates([])).toEqual([]);
  });
});
