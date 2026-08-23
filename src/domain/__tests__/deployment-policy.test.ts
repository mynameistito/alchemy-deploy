import { describe, expect, test } from "bun:test";

import {
  deploymentPolicy,
  hasActiveDeployment,
  previewStage,
} from "@/domain/deployment-policy.ts";
import type { PolicyInput } from "@/domain/deployment-policy.ts";

const sha = "a".repeat(40);
const pr = (
  overrides: Partial<NonNullable<PolicyInput["pullRequest"]>> = {}
) => ({
  headRepositoryId: 7,
  number: 42,
  repositoryId: 7,
  sha,
  state: "open" as const,
  ...overrides,
});

describe("deployment policy", () => {
  test("deploys an exact same-repository PR head", () => {
    expect(
      deploymentPolicy({
        branch: "feature",
        conclusion: "success",
        event: "pull_request",
        kind: "workflow_run",
        productionBranch: "main",
        pullRequest: pr(),
        sha,
      })
    ).toEqual({ kind: "deploy", sha, stage: "pr-42" });
  });

  test.each(["failure", "cancelled"])("refuses %s CI", (conclusion) => {
    expect(
      deploymentPolicy({
        branch: "feature",
        conclusion,
        event: "pull_request",
        kind: "workflow_run",
        productionBranch: "main",
        pullRequest: pr(),
        sha,
      }).kind
    ).toBe("noop");
  });

  test("refuses forks and stale PR heads", () => {
    expect(
      deploymentPolicy({
        branch: "feature",
        conclusion: "success",
        event: "pull_request",
        kind: "workflow_run",
        productionBranch: "main",
        pullRequest: pr({ headRepositoryId: 8 }),
        sha,
      }).kind
    ).toBe("noop");
    expect(
      deploymentPolicy({
        branch: "feature",
        conclusion: "success",
        event: "pull_request",
        kind: "workflow_run",
        productionBranch: "main",
        pullRequest: pr({ sha: "b".repeat(40) }),
        sha,
      }).kind
    ).toBe("noop");
  });

  test("gates production on the current main SHA", () => {
    const input = {
      branch: "main",
      conclusion: "success",
      currentMainSha: sha,
      event: "push" as const,
      kind: "workflow_run" as const,
      productionBranch: "main",
      sha,
    };
    expect(deploymentPolicy(input)).toEqual({
      kind: "deploy",
      sha,
      stage: "prod",
    });
    expect(
      deploymentPolicy({ ...input, currentMainSha: "b".repeat(40) }).kind
    ).toBe("noop");
  });

  test("only cleans the PR stage", () => {
    expect(
      deploymentPolicy({
        action: "closed",
        headRepositoryId: 7,
        kind: "pull_request",
        number: 42,
        repositoryId: 7,
      })
    ).toEqual({ kind: "cleanup", stage: "pr-42" });
    expect(
      deploymentPolicy({
        action: "closed",
        headRepositoryId: 7,
        kind: "pull_request",
        number: 0,
        repositoryId: 7,
      }).kind
    ).toBe("noop");
    expect(
      deploymentPolicy({
        action: "closed",
        headRepositoryId: 8,
        kind: "pull_request",
        number: 42,
        repositoryId: 7,
      }).kind
    ).toBe("noop");
  });

  test("makes duplicate and independent identities explicit", () => {
    expect(hasActiveDeployment([{ sha, state: "success" }], sha)).toBeTrue();
    expect(
      hasActiveDeployment([{ sha: "b".repeat(40), state: "success" }], sha)
    ).toBeFalse();
    expect(previewStage(69)).toEqual({ _tag: "ok", value: "pr-69" });
  });
});
