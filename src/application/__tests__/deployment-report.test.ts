import { describe, expect, test } from "bun:test";

import { runDeploymentReport } from "@/application/deployment-report.ts";
import type { ReportContext } from "@/application/deployment-report.ts";
import {
  parseCommitSha,
  parseDeploymentStage,
  parseWorkerName,
} from "@/domain/deployment.ts";
import type { GitHubDeploymentPort } from "@/github/github-api.ts";
import { GitHubApiError } from "@/github/github-api.ts";
import { err, ok } from "@/shared/result.ts";

/* oxlint-disable require-await -- Fake ports fulfill asynchronous contracts without external I/O. */

const contextFor = (stageName: string): ReportContext => {
  const commit = parseCommitSha("b".repeat(40));
  const stage = parseDeploymentStage(stageName);
  const worker = parseWorkerName("worker");
  if (commit._tag === "err" || stage._tag === "err" || worker._tag === "err") {
    throw new Error("test fixture failed to parse");
  }
  return {
    commitSha: commit.value,
    owner: "owner",
    repository: "repo",
    runUrl: "https://github.com/owner/repo/actions/runs/1",
    stage: stage.value,
    worker: worker.value,
  };
};

describe("deployment cleanup", () => {
  test("deactivates each deployment immediately before deleting it", async () => {
    const operations: string[] = [];
    const github: GitHubDeploymentPort = {
      createComment: async () => ok(true),
      createDeployment: async () => ok(1),
      createDeploymentStatus: async ({ deploymentId, state }) => {
        operations.push(`${state}:${deploymentId}`);
        return ok(true);
      },
      deleteDeployment: async (id) => {
        operations.push(`delete:${id}`);
        return ok(true);
      },
      listComments: async () => ok([]),
      listDeployments: async () => ok([{ id: 1 }, { id: 2 }]),
      updateComment: async () => ok(true),
    };
    const result = await runDeploymentReport(github, {
      _tag: "cleanup",
      context: contextFor("pr-8"),
    });
    expect(result).toEqual({ _tag: "ok", value: { deletedDeployments: 2 } });
    expect(operations).toEqual([
      "inactive:1",
      "delete:1",
      "inactive:2",
      "delete:2",
    ]);
  });

  test("refuses production cleanup before listing deployments", async () => {
    let listed = false;
    const github: GitHubDeploymentPort = {
      createComment: async () => ok(true),
      createDeployment: async () => ok(1),
      createDeploymentStatus: async () => ok(true),
      deleteDeployment: async () => ok(true),
      listComments: async () => ok([]),
      listDeployments: async () => {
        listed = true;
        return ok([]);
      },
      updateComment: async () => ok(true),
    };
    const result = await runDeploymentReport(github, {
      _tag: "cleanup",
      context: contextFor("prod"),
    });
    expect(result._tag).toBe("err");
    expect(listed).toBeFalse();
  });
});

describe("deployment creation", () => {
  test("preserves the deployment ID when the initial status fails", async () => {
    const github: GitHubDeploymentPort = {
      createComment: async () => ok(true),
      createDeployment: async () => ok(42),
      createDeploymentStatus: async () =>
        err(
          new GitHubApiError(
            "create deployment status",
            503,
            "temporarily unavailable"
          )
        ),
      deleteDeployment: async () => ok(true),
      listComments: async () => ok([]),
      listDeployments: async () => ok([]),
      updateComment: async () => ok(true),
    };
    const result = await runDeploymentReport(github, {
      _tag: "create",
      context: contextFor("prod"),
    });
    expect(result._tag).toBe("err");
    if (result._tag === "err") {
      expect(result.error.deploymentId).toBe(42);
    }
  });
});
