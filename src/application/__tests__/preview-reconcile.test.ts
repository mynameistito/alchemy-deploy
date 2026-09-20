import { describe, expect, test } from "bun:test";

import { runPreviewReconcile } from "@/application/preview-reconcile.ts";
import type { PreviewReconcilePorts } from "@/application/preview-reconcile.ts";
import type { PreviewCandidate } from "@/domain/preview-reconcile.ts";
import { err, ok } from "@/shared/result.ts";

const candidate = (stage: string, pullRequest: number): PreviewCandidate => ({
  pullRequest,
  sha: "a".repeat(40),
  stage,
});

const ports = (
  overrides: Partial<PreviewReconcilePorts>
): PreviewReconcilePorts => ({
  candidates: () => Promise.resolve(ok([])),
  cleanup: () => Promise.resolve(ok(true)),
  diagnostic: () => Promise.resolve(),
  isPullRequestOpen: () => Promise.resolve(ok(false)),
  ...overrides,
});

describe("preview reconcile", () => {
  test("destroys only previews whose pull request is closed", async () => {
    const destroyed: string[] = [];
    const result = await runPreviewReconcile(
      ports({
        candidates: () =>
          Promise.resolve(ok([candidate("pr-1", 1), candidate("pr-2", 2)])),
        cleanup: (value) => {
          destroyed.push(value.stage);
          return Promise.resolve(ok(true));
        },
        isPullRequestOpen: (pullRequest) =>
          Promise.resolve(ok(pullRequest === 2)),
      })
    );

    expect(result).toEqual(ok({ failed: 0, reconciled: 1, skipped: 1 }));
    expect(destroyed).toEqual(["pr-1"]);
  });

  test("skips a stage whose pull request cannot be resolved", async () => {
    const messages: string[] = [];
    const result = await runPreviewReconcile(
      ports({
        candidates: () => Promise.resolve(ok([candidate("pr-9", 9)])),
        diagnostic: (message) => {
          messages.push(message);
          return Promise.resolve();
        },
        isPullRequestOpen: () =>
          Promise.resolve(err(new Error("rate limited"))),
      })
    );

    expect(result).toEqual(ok({ failed: 0, reconciled: 0, skipped: 1 }));
    expect(messages).toEqual(["Preview reconcile skipped pr-9: rate limited"]);
  });

  test("continues the sweep when one cleanup fails", async () => {
    const messages: string[] = [];
    const order: string[] = [];
    const result = await runPreviewReconcile(
      ports({
        candidates: () =>
          Promise.resolve(ok([candidate("pr-1", 1), candidate("pr-2", 2)])),
        cleanup: (value) => {
          order.push(value.stage);
          return value.stage === "pr-1"
            ? Promise.resolve(err(new Error("destroy failed")))
            : Promise.resolve(ok(true));
        },
        diagnostic: (message) => {
          messages.push(message);
          return Promise.resolve();
        },
      })
    );

    expect(result).toEqual(ok({ failed: 1, reconciled: 1, skipped: 0 }));
    expect(order).toEqual(["pr-1", "pr-2"]);
    expect(messages).toEqual(["Preview reconcile failed pr-1: destroy failed"]);
  });

  test("stops before cleanup when previews cannot be listed", async () => {
    const result = await runPreviewReconcile(
      ports({ candidates: () => Promise.resolve(err(new Error("no token"))) })
    );

    expect(result).toEqual(err(new Error("no token")));
  });
});
