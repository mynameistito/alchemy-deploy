import { describe, expect, test } from "bun:test";

import { runDeploymentOrchestration } from "@/application/deployment-orchestration.ts";
import type {
  ConsumerCommand,
  DeploymentOrchestrationPlan,
  DeploymentOrchestrationPorts,
} from "@/application/deployment-orchestration.ts";
import type {
  DeploymentReportCommand,
  ReportContext,
} from "@/application/deployment-report.ts";
import {
  parseCommitSha,
  parseDeploymentStage,
  parseWorkerName,
} from "@/domain/deployment.ts";
import { err, ok } from "@/shared/result.ts";

const context = (): ReportContext => {
  const commit = parseCommitSha("a".repeat(40));
  const stage = parseDeploymentStage("pr-42");
  const worker = parseWorkerName("worker");
  if (commit._tag === "err" || stage._tag === "err" || worker._tag === "err") {
    throw new Error("fixture failed to parse");
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

const consumer: ConsumerCommand = {
  command: "bun run deploy",
  environment: { STAGE: "pr-42" },
  logPath: "/tmp/deploy.log",
};

const deployPlan = (): DeploymentOrchestrationPlan => ({
  _tag: "deploy",
  consumer,
  context: context(),
  issueNumber: 42,
  links: {
    accountId: "account",
    logPath: consumer.logPath,
    outcome: "success",
    stage: context().stage,
    urlConfig: {
      previewUrlPattern: "https://{worker}-{stage}.*.workers.dev",
      productionUrl: "https://worker.example.com",
    },
    worker: context().worker,
  },
});

const portsFor = (overrides: Partial<DeploymentOrchestrationPorts> = {}) => {
  const reports: DeploymentReportCommand[] = [];
  const diagnostics: string[] = [];
  const ports: DeploymentOrchestrationPorts = {
    consumer: () => Promise.resolve(ok("success")),
    diagnostic: (message) => {
      diagnostics.push(message);
      return Promise.resolve();
    },
    links: () =>
      Promise.resolve(
        ok({
          deploymentUrl: "https://worker-pr-42.example.com",
          logsUrl: "https://dash.cloudflare.com/logs",
        })
      ),
    recheck: () => Promise.resolve(ok(true)),
    report: (command) => {
      reports.push(command);
      return Promise.resolve(
        command._tag === "create" ? ok({ deploymentId: 7 }) : ok({})
      );
    },
    ...overrides,
  };
  return { diagnostics, ports, reports };
};

describe("deployment orchestration", () => {
  test("handles noop without calling any port", async () => {
    const { ports } = portsFor();
    const result = await runDeploymentOrchestration({ _tag: "noop" }, ports);
    expect(result).toEqual({ _tag: "ok", value: { phase: "noop" } });
  });

  test("creates, runs, resolves, completes, and comments a successful preview", async () => {
    const { ports, reports } = portsFor();
    const result = await runDeploymentOrchestration(deployPlan(), ports);
    expect(result._tag).toBe("ok");
    expect(reports.map(({ _tag }) => _tag)).toEqual([
      "create",
      "complete",
      "comment",
    ]);
  });

  test("completes a failed deployment when link resolution fails", async () => {
    const { ports, reports } = portsFor({
      links: () => Promise.resolve(err(new Error("URL not found"))),
    });
    const result = await runDeploymentOrchestration(deployPlan(), ports);
    expect(result._tag).toBe("err");
    if (result._tag === "err") {
      expect(result.error.deploymentId).toBe(7);
    }
    expect(reports).toEqual([
      { _tag: "create", context: context() },
      {
        _tag: "complete",
        context: context(),
        deploymentId: 7,
        logsUrl: "https://github.com/owner/repo/actions/runs/1",
        outcome: "failure",
      },
    ]);
  });

  test("reports a failed deploy and retains its deployment ID", async () => {
    const { ports, reports } = portsFor({
      consumer: () => Promise.resolve(ok("failure")),
    });
    const result = await runDeploymentOrchestration(deployPlan(), ports);

    expect(result._tag).toBe("err");
    if (result._tag === "err") {
      expect(result.error.deploymentId).toBe(7);
    }
    expect(reports.map(({ _tag }) => _tag)).toEqual([
      "create",
      "complete",
      "comment",
    ]);
  });

  test("records stale recheck as a deployment failure before creating a record", async () => {
    const { diagnostics, ports, reports } = portsFor({
      recheck: () => Promise.resolve(err(new Error("head changed"))),
    });
    const result = await runDeploymentOrchestration(deployPlan(), ports);
    expect(result._tag).toBe("err");
    expect(reports).toHaveLength(0);
    expect(diagnostics[0]).toContain("stale policy recheck");
  });

  test("runs cleanup and retains diagnostics when the command fails", async () => {
    const { diagnostics, ports, reports } = portsFor({
      consumer: () => Promise.resolve(ok("failure")),
    });
    const result = await runDeploymentOrchestration(
      { _tag: "cleanup", consumer, context: context() },
      ports
    );
    expect(result._tag).toBe("err");
    expect(reports).toHaveLength(0);
    expect(diagnostics[0]).toContain("Preview cleanup failed");
  });

  test("reports successful cleanup", async () => {
    const { ports, reports } = portsFor();
    const result = await runDeploymentOrchestration(
      { _tag: "cleanup", consumer, context: context() },
      ports
    );

    expect(result).toEqual({ _tag: "ok", value: { phase: "cleanup" } });
    expect(reports.map(({ _tag }) => _tag)).toEqual(["cleanup"]);
  });
});
