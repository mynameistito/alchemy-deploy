import type { PreviewCandidate } from "@/domain/preview-reconcile.ts";
import { err, ok } from "@/shared/result.ts";
import type { Result } from "@/shared/result.ts";

/** Outcome counts from one preview reconcile sweep. */
export interface PreviewReconcileOutcome {
  /** Preview stages whose cleanup command did not succeed. */
  readonly failed: number;
  /** Preview stages destroyed during this sweep. */
  readonly reconciled: number;
  /** Preview stages left alone because their pull request is open or unresolved. */
  readonly skipped: number;
}

/** Ports used by the scheduled preview reconcile. */
export interface PreviewReconcilePorts {
  /** List preview stages present in the repository's deployment records. */
  readonly candidates: () => Promise<
    Result<readonly PreviewCandidate[], Error>
  >;
  /** Destroy one preview stage and clear its deployment records. */
  readonly cleanup: (
    candidate: PreviewCandidate
  ) => Promise<Result<true, Error>>;
  /** Record a diagnostic that is not a hard failure. */
  readonly diagnostic: (message: string) => Promise<void>;
  /** Resolve whether a pull request is still open. */
  readonly isPullRequestOpen: (
    pullRequest: number
  ) => Promise<Result<boolean, Error>>;
}

/**
 * Destroy preview stages whose pull request is no longer open.
 *
 * This runs independently of the `pull_request: closed` event, so a close
 * event that never executed cannot leave a preview Worker serving after its
 * pull request closed. Each stage is resolved and destroyed on its own: a
 * failure on one stage is reported and the sweep continues.
 */
export const runPreviewReconcile = async (
  ports: PreviewReconcilePorts
): Promise<Result<PreviewReconcileOutcome, Error>> => {
  const candidates = await ports.candidates();
  if (candidates._tag === "err") {
    return err(candidates.error);
  }
  let reconciled = 0;
  let skipped = 0;
  let failed = 0;
  for (const candidate of candidates.value) {
    // oxlint-disable-next-line no-await-in-loop -- Each preview stage is resolved on its own.
    const open = await ports.isPullRequestOpen(candidate.pullRequest);
    if (open._tag === "err") {
      skipped += 1;
      // oxlint-disable-next-line no-await-in-loop -- The diagnostic belongs to this stage.
      await ports.diagnostic(
        `Preview reconcile skipped ${candidate.stage}: ${open.error.message}`
      );
      continue;
    }
    if (open.value) {
      skipped += 1;
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- Cleanup preserves evidence one stage at a time.
    const cleanup = await ports.cleanup(candidate);
    if (cleanup._tag === "err") {
      failed += 1;
      // oxlint-disable-next-line no-await-in-loop -- The diagnostic belongs to this stage.
      await ports.diagnostic(
        `Preview reconcile failed ${candidate.stage}: ${cleanup.error.message}`
      );
      continue;
    }
    reconciled += 1;
  }
  return ok({ failed, reconciled, skipped });
};
