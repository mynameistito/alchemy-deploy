import { err, ok } from "../shared/result.ts";
import type { Result } from "../shared/result.ts";

const PREVIEW_STAGE = /^pr-[1-9]\d*$/u;
const PRODUCTION_STAGE = /^[a-z][a-z0-9_-]{0,62}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** A supported reporting operation. */
export type ReportMode = "create" | "complete" | "comment" | "cleanup";

/** A parsed deployment stage. */
export type DeploymentStage =
  | { readonly _tag: "production"; readonly value: string }
  | { readonly _tag: "preview"; readonly pullRequest: number; readonly value: string };

/** A parsed Git commit SHA. */
export type CommitSha = string & { readonly CommitSha: unique symbol };

/** A parsed Cloudflare Worker name. */
export type WorkerName = string & { readonly WorkerName: unique symbol };

/** A boundary parsing failure. */
export class DeploymentInputError extends Error {
  readonly _tag = "DeploymentInputError" as const;
  override readonly name = "DeploymentInputError";
  readonly field: string;

  /** Create an input error with a safe field name and explanation. */
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}

/** Parse a reporting mode from external input. */
export const parseReportMode = (
  input: string | undefined,
): Result<ReportMode, DeploymentInputError> => {
  if (input === "create" || input === "complete" || input === "comment" || input === "cleanup") {
    return ok(input);
  }
  return err(new DeploymentInputError("mode", "must be create, complete, comment, or cleanup"));
};

/** Parse a production or isolated pull-request stage. */
export const parseDeploymentStage = (
  input: string | undefined,
  productionStage = "prod",
): Result<DeploymentStage, DeploymentInputError> => {
  if (!PRODUCTION_STAGE.test(productionStage) || PREVIEW_STAGE.test(productionStage)) {
    return err(
      new DeploymentInputError(
        "production-stage",
        "must be a safe stage name distinct from pr-<positive integer>",
      ),
    );
  }
  if (input === productionStage) {
    return ok({ _tag: "production", value: input });
  }
  if (input && PREVIEW_STAGE.test(input)) {
    const pullRequest = Number(input.slice(3));
    return ok({ _tag: "preview", pullRequest, value: input });
  }
  return err(
    new DeploymentInputError(
      "stage",
      `must be ${productionStage} or an isolated pr-<positive integer> stage`,
    ),
  );
};

/** Parse a full lowercase Git commit SHA. */
export const parseCommitSha = (
  input: string | undefined,
): Result<CommitSha, DeploymentInputError> => {
  if (!input || !SHA.test(input)) {
    return err(new DeploymentInputError("deployment-sha", "must be a full lowercase SHA"));
  }
  // SAFETY: The regular expression above establishes the CommitSha invariant.
  return ok(input as CommitSha);
};

/** Parse a Cloudflare-compatible Worker name. */
export const parseWorkerName = (
  input: string | undefined,
): Result<WorkerName, DeploymentInputError> => {
  if (!input || !WORKER_NAME.test(input)) {
    return err(
      new DeploymentInputError(
        "worker-name",
        "must contain lowercase letters, numbers, or interior hyphens",
      ),
    );
  }
  // SAFETY: The regular expression above establishes the WorkerName invariant.
  return ok(input as WorkerName);
};

/** Return the physical Worker name for a stage. */
export const physicalWorkerName = (worker: WorkerName, stage: DeploymentStage): string =>
  stage._tag === "production" ? worker : `${worker}-${stage.value}`;

/** Return whether a stage is safe for automated teardown. */
export const isPreviewStage = (
  stage: DeploymentStage,
): stage is Extract<DeploymentStage, { readonly _tag: "preview" }> => stage._tag === "preview";
