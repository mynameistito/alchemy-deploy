import { describe, expect, test } from "bun:test";

import { runDeploymentPolicy } from "@/actions/deployment-policy-main.ts";
import type { GitHubPolicyPort } from "@/github/github-api.ts";
import { ok } from "@/shared/result.ts";

const sha = "a".repeat(40);
const environment = (overrides: Record<string, string> = {}) => ({
  CI_WORKFLOW: "ci.yml",
  DEPLOYMENT_SHA: sha,
  EVENT_NAME: "workflow_run",
  GITHUB_TOKEN: "secret",
  PRODUCTION_BRANCH: "main",
  PRODUCTION_STAGE: "prod",
  PULL_REQUEST_NUMBER: "42",
  REPOSITORY: "owner/repo",
  REPOSITORY_ID: "7",
  WORKFLOW_RUN_BRANCH: "feature",
  WORKFLOW_RUN_CONCLUSION: "success",
  WORKFLOW_RUN_EVENT: "pull_request",
  WORKFLOW_RUN_ID: "12",
  ...overrides,
});

const github = (
  overrides: Partial<GitHubPolicyPort> = {}
): GitHubPolicyPort => ({
  createComment: () => Promise.resolve(ok(true)),
  createDeployment: () => Promise.resolve(ok(1)),
  createDeploymentStatus: () => Promise.resolve(ok(true)),
  deleteDeployment: () => Promise.resolve(ok(true)),
  getBranchSha: () => Promise.resolve(ok(sha)),
  getPullRequest: () =>
    Promise.resolve(
      ok({
        headRepositoryId: 7,
        number: 42,
        repositoryId: 7,
        sha,
        state: "open" as const,
      })
    ),
  getWorkflowId: () => Promise.resolve(ok(12)),
  listComments: () => Promise.resolve(ok([])),
  listDeployments: () => Promise.resolve(ok([])),
  updateComment: () => Promise.resolve(ok(true)),
  ...overrides,
});

const outputs = (input: Record<string, string>, port = github()) =>
  runDeploymentPolicy(environment(), port, (name, value) => {
    input[name] = value;
    return Promise.resolve();
  });

const decisionKind = (
  result: Awaited<ReturnType<typeof runDeploymentPolicy>>
) => (result._tag === "ok" ? result.value.kind : "error");

describe("deployment policy action boundary", () => {
  test("uses the exact entrypoint for a trusted PR head", async () => {
    const written: Record<string, string> = {};
    const result = await outputs(written);
    expect(result).toEqual({
      _tag: "ok",
      value: { kind: "deploy", sha, stage: "pr-42" },
    });
    expect(written).toEqual({
      cleanup: "false",
      deploy: "true",
      "deployment-sha": sha,
      preview: "true",
      "pull-request-number": "42",
      stage: "pr-42",
    });
  });

  test("refuses malformed event data and configured workflow mismatches", async () => {
    const malformed = await runDeploymentPolicy(
      environment({ REPOSITORY_ID: "bad" }),
      github(),
      () => Promise.resolve()
    );
    expect(malformed._tag).toBe("err");
    const mismatch = await runDeploymentPolicy(
      environment(),
      github({ getWorkflowId: () => Promise.resolve(ok(13)) }),
      () => Promise.resolve()
    );
    expect(mismatch).toEqual({
      _tag: "ok",
      value: { kind: "noop", reason: "configured workflow mismatch" },
    });
  });

  test("refuses stale heads, forks, and duplicate deployments", async () => {
    const stale = await outputs(
      {},
      github({
        getPullRequest: () =>
          Promise.resolve(
            ok({
              headRepositoryId: 7,
              number: 42,
              repositoryId: 7,
              sha: "b".repeat(40),
              state: "open",
            })
          ),
      })
    );
    expect(decisionKind(stale)).toBe("noop");
    const fork = await outputs(
      {},
      github({
        getPullRequest: () =>
          Promise.resolve(
            ok({
              headRepositoryId: 8,
              number: 42,
              repositoryId: 7,
              sha,
              state: "open",
            })
          ),
      })
    );
    expect(decisionKind(fork)).toBe("noop");
    const duplicate = await outputs(
      {},
      github({
        listDeployments: () =>
          Promise.resolve(ok([{ id: 1, sha, state: "in_progress" }])),
      })
    );
    expect(decisionKind(duplicate)).toBe("noop");
  });

  test("gates production on the current branch and only cleans valid PR stages", async () => {
    const staleProduction = await runDeploymentPolicy(
      environment({ WORKFLOW_RUN_BRANCH: "main", WORKFLOW_RUN_EVENT: "push" }),
      github({ getBranchSha: () => Promise.resolve(ok("b".repeat(40))) }),
      () => Promise.resolve()
    );
    expect(decisionKind(staleProduction)).toBe("noop");
    const cleanup = await runDeploymentPolicy(
      {
        EVENT_ACTION: "closed",
        EVENT_NAME: "pull_request",
        PULL_REQUEST_HEAD_REPOSITORY_ID: "7",
        PULL_REQUEST_NUMBER: "42",
        REPOSITORY_ID: "7",
      },
      github(),
      () => Promise.resolve()
    );
    expect(cleanup).toEqual({
      _tag: "ok",
      value: { kind: "cleanup", stage: "pr-42" },
    });
    const invalidCleanup = await runDeploymentPolicy(
      {
        EVENT_ACTION: "closed",
        EVENT_NAME: "pull_request",
        PULL_REQUEST_HEAD_REPOSITORY_ID: "7",
        PULL_REQUEST_NUMBER: "0",
        REPOSITORY_ID: "7",
      },
      github(),
      () => Promise.resolve()
    );
    expect(decisionKind(invalidCleanup)).toBe("noop");
  });
});
