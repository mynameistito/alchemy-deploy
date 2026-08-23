import { describe, expect, test } from "bun:test";

import {
  parseCommitSha,
  parseDeploymentStage,
  parseWorkerName,
} from "@/domain/deployment.ts";
import {
  deploymentCommentMarker,
  hasDeploymentCommentMarker,
  renderDeploymentComment,
} from "@/github/deployment-comment.ts";

const parsedFixtures = () => {
  const commit = parseCommitSha("a".repeat(40));
  const stage = parseDeploymentStage("pr-42");
  const worker = parseWorkerName("x-lookup");
  if (commit._tag === "err" || stage._tag === "err" || worker._tag === "err") {
    throw new Error("test fixture failed to parse");
  }
  return { commit: commit.value, stage: stage.value, worker: worker.value };
};

describe("deployment comments", () => {
  test("renders stable diagnostics and deployment details", () => {
    const { commit, stage, worker } = parsedFixtures();
    const body = renderDeploymentComment({
      commitSha: commit,
      deploymentUrl: "https://x-lookup-pr-42.foo.workers.dev",
      logsUrl: "https://dash.cloudflare.com/logs",
      outcome: "success",
      owner: "owner",
      repository: "repo",
      runUrl: "https://github.com/owner/repo/actions/runs/1",
      stage,
      updatedAt: new Date("2026-08-23T00:00:00.000Z"),
      worker,
    });
    expect(body).toContain(deploymentCommentMarker(stage));
    expect(body).toContain("x-lookup-pr-42");
    expect(body).toContain("2026-08-23T00:00:00.000Z");
    expect(body).toContain(
      "alchemy-deploy/c8640f1df20812b904f5d3f9ee50c3fb1cb7e7c8/assets/alchemy.svg"
    );
  });

  test("matches only an exact marker line for the requested stage", () => {
    const { stage } = parsedFixtures();
    expect(
      hasDeploymentCommentMarker("<!-- alchemy-deploy:pr-42 -->", stage)
    ).toBeTrue();
    expect(
      hasDeploymentCommentMarker("prefix <!-- alchemy-deploy:pr-42 -->", stage)
    ).toBeFalse();
    expect(
      hasDeploymentCommentMarker("<!-- alchemy-deploy:pr-420 -->", stage)
    ).toBeFalse();
  });
});
