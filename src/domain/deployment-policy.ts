import { err, ok } from "@/shared/result.ts";
import type { Result } from "@/shared/result.ts";

export interface PolicyInput {
  readonly action?: string;
  readonly branch?: string;
  readonly conclusion?: string;
  readonly currentMainSha?: string;
  readonly event?: "pull_request" | "push";
  readonly headRepositoryId?: number;
  readonly kind: "pull_request" | "workflow_run";
  readonly number?: number;
  readonly productionBranch?: string;
  readonly pullRequest?: {
    readonly headRepositoryId: number;
    readonly number: number;
    readonly repositoryId: number;
    readonly sha: string;
    readonly state: "open" | "closed";
  };
  readonly repositoryId?: number;
  readonly sha?: string;
}

export type PolicyDecision =
  | { readonly kind: "deploy"; readonly stage: string; readonly sha: string }
  | { readonly kind: "cleanup"; readonly stage: string }
  | { readonly kind: "noop"; readonly reason: string };

export const previewStage = (number: number): Result<string, string> =>
  Number.isSafeInteger(number) && number > 0
    ? ok(`pr-${number}`)
    : err("invalid pull request number");

export const deploymentPolicy = (input: PolicyInput): PolicyDecision => {
  if (input.kind === "pull_request") {
    if (input.action !== "closed") {
      return {
        kind: "noop",
        reason: "deployment is trusted workflow_run only",
      };
    }
    if (input.number === undefined) {
      return { kind: "noop", reason: "invalid pull request number" };
    }
    const stage = previewStage(input.number);
    if (stage._tag === "err") {
      return { kind: "noop", reason: stage.error };
    }
    return input.headRepositoryId !== undefined &&
      input.headRepositoryId === input.repositoryId
      ? { kind: "cleanup", stage: stage.value }
      : { kind: "noop", reason: "fork pull request" };
  }

  if (input.conclusion !== "success" || !input.sha) {
    return { kind: "noop", reason: "CI did not succeed" };
  }
  if (input.event === "push") {
    return input.branch === input.productionBranch &&
      input.currentMainSha === input.sha
      ? { kind: "deploy", sha: input.sha, stage: "prod" }
      : { kind: "noop", reason: "stale production CI" };
  }
  if (input.event !== "pull_request") {
    return { kind: "noop", reason: "unsupported workflow event" };
  }
  const { pullRequest } = input;
  if (!pullRequest) {
    return { kind: "noop", reason: "pull request was not resolved" };
  }
  const stage = previewStage(pullRequest.number);
  if (stage._tag === "err") {
    return { kind: "noop", reason: stage.error };
  }
  return pullRequest.state === "open" &&
    pullRequest.headRepositoryId === pullRequest.repositoryId &&
    pullRequest.sha === input.sha
    ? { kind: "deploy", sha: input.sha, stage: stage.value }
    : { kind: "noop", reason: "stale or untrusted pull request CI" };
};

export const hasActiveDeployment = (
  deployments: readonly { readonly sha: string; readonly state: string }[],
  sha: string
): boolean =>
  deployments.some(
    (deployment) =>
      deployment.sha === sha &&
      (deployment.state === "success" || deployment.state === "in_progress")
  );
