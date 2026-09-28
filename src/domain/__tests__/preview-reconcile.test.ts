import { describe, expect, test } from "bun:test";

import { previewCandidates } from "@/domain/preview-reconcile.ts";

const sha = (digit: string): string => digit.repeat(40);

describe("preview reconcile candidates", () => {
  test("keeps one entry per preview stage in newest-first order", () => {
    const candidates = previewCandidates(
      [
        { environment: "pr-103", sha: sha("a"), worker: "api" },
        { environment: "pr-103", sha: sha("b"), worker: "api" },
        { environment: "production", sha: sha("c"), worker: "api" },
        { environment: "pr-100", sha: sha("d"), worker: "api" },
        { environment: "pr-100", sha: sha("e"), worker: "other" },
      ],
      "api"
    );

    expect(candidates).toEqual([
      { pullRequest: 103, sha: sha("a"), stage: "pr-103", worker: "api" },
      { pullRequest: 100, sha: sha("d"), stage: "pr-100", worker: "api" },
    ]);
  });

  test("ignores non-preview deployment environments", () => {
    const candidates = previewCandidates(
      [
        { environment: "prod", sha: sha("a"), worker: "api" },
        { environment: "preview", sha: sha("b"), worker: "api" },
        { environment: "pr-", sha: sha("c"), worker: "api" },
        { environment: "pr-x", sha: sha("d"), worker: "api" },
        { environment: "pr-0", sha: sha("e"), worker: "api" },
        { environment: "pr-1", sha: sha("f"), worker: "api" },
      ],
      "api"
    );

    expect(candidates).toEqual([
      { pullRequest: 1, sha: sha("f"), stage: "pr-1", worker: "api" },
    ]);
  });

  test("returns nothing without deployment records", () => {
    expect(previewCandidates([], "api")).toEqual([]);
  });
});
