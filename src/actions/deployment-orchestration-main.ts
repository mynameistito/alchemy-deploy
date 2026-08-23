import { appendFile, readFile } from "node:fs/promises";

import { recheckDeploymentPolicy } from "@/actions/deployment-policy-main.ts";
import { parseReportEnvironment } from "@/actions/report-input.ts";
import { runDeploymentOrchestration } from "@/application/deployment-orchestration.ts";
import type {
  ConsumerCommand,
  DeploymentLinkInput,
} from "@/application/deployment-orchestration.ts";
import { runDeploymentReport } from "@/application/deployment-report.ts";
import {
  resolveDeploymentUrl,
  cloudflareLogsUrl,
} from "@/domain/deployment-url.ts";
import { createGitHubApi } from "@/github/github-api.ts";
import { err, ok } from "@/shared/result.ts";
import type { Result } from "@/shared/result.ts";

const required = (name: string): Result<string, Error> => {
  const value = Bun.env[name]?.trim();
  return value ? ok(value) : err(new Error(`${name} is required`));
};

const environmentFor = (command: ConsumerCommand) => {
  const environment = {
    ...command.environment,
    ALCHEMY_WORKER_CONFIG: Bun.env.ALCHEMY_WORKER_CONFIG ?? "",
    CLOUDFLARE_ACCOUNT_ID: Bun.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    CLOUDFLARE_API_TOKEN: Bun.env.CLOUDFLARE_API_TOKEN ?? "",
    GITHUB_TOKEN: "",
    STAGE: command.environment.STAGE ?? "",
  } satisfies Record<string, string>;
  return environment;
};

const runBash = async (
  command: ConsumerCommand
): Promise<Result<"success" | "failure", Error>> => {
  const process = Bun.spawn(
    [
      "bash",
      "-euo",
      "pipefail",
      "-c",
      'bash -euo pipefail -c "$CONSUMER_COMMAND" 2>&1 | tee "$LOG_PATH"',
    ],
    {
      env: {
        ...Bun.env,
        ...environmentFor(command),
        CONSUMER_COMMAND: command.command,
        LOG_PATH: command.logPath,
      },
      stderr: "inherit",
      stdout: "inherit",
    }
  );
  const exitCode = await process.exited;
  return ok(exitCode === 0 ? "success" : "failure");
};

const resolveLinks = async (
  input: DeploymentLinkInput
): Promise<Result<{ logsUrl: string; deploymentUrl?: string }, Error>> => {
  const logs = cloudflareLogsUrl(input.accountId, input.worker, input.stage);
  if (logs._tag === "err") {
    return logs;
  }
  if (input.outcome !== "success") {
    return ok({ logsUrl: logs.value });
  }
  let log: string;
  try {
    log = await readFile(input.logPath, "utf-8");
  } catch (error) {
    return err(
      new Error(
        `Could not read Alchemy deployment output: ${error instanceof Error ? error.message : "unknown error"}`
      )
    );
  }
  const deployment = resolveDeploymentUrl(
    log,
    input.stage,
    input.worker,
    input.urlConfig
  );
  return deployment._tag === "err"
    ? deployment
    : ok({ deploymentUrl: deployment.value, logsUrl: logs.value });
};

const diagnostic = async (message: string): Promise<void> => {
  const path = Bun.env.GITHUB_STEP_SUMMARY;
  if (path) {
    await appendFile(
      path,
      `## Alchemy deployment diagnostics\n\n${message}\n`,
      "utf-8"
    );
  }
};

const main = async (): Promise<number> => {
  const phase = required("PHASE");
  const token = required("GITHUB_TOKEN");
  if (phase._tag === "err") {
    console.error(`::error::${phase.error.message}`);
    return 1;
  }
  if (token._tag === "err") {
    console.error(`::error::${token.error.message}`);
    return 1;
  }
  const mode = phase.value === "cleanup" ? "cleanup" : "create";
  const parsed = parseReportEnvironment({ ...Bun.env, MODE: mode }, new Date());
  if (parsed._tag === "err") {
    console.error(
      `::error::Invalid orchestration input: ${parsed.error.message}`
    );
    return 1;
  }
  const { context } = parsed.value.command;
  const github = createGitHubApi({
    apiUrl: parsed.value.apiUrl,
    owner: context.owner,
    repository: context.repository,
    token: parsed.value.token,
  });
  const command: ConsumerCommand = {
    command:
      mode === "create"
        ? `${Bun.env.DEPLOY_COMMAND ?? ""}${Bun.env.USE_ADOPT === "true" ? " --adopt" : ""}`
        : (Bun.env.DESTROY_COMMAND ?? ""),
    environment: {
      STAGE: context.stage.value,
    },
    logPath:
      Bun.env.LOG_PATH ?? `${Bun.env.RUNNER_TEMP ?? "."}/alchemy-${mode}.log`,
  };
  const ports = {
    consumer: runBash,
    diagnostic,
    links: resolveLinks,
    recheck: () => recheckDeploymentPolicy(Bun.env, github),
    report: (reportCommand: Parameters<typeof runDeploymentReport>[1]) =>
      runDeploymentReport(github, reportCommand),
  };
  const links: DeploymentLinkInput = {
    accountId: Bun.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    logPath: command.logPath,
    outcome: "success",
    stage: context.stage,
    urlConfig: {
      previewUrlPattern: Bun.env.PREVIEW_PATTERN ?? "",
      productionUrl: Bun.env.PRODUCTION_URL ?? "",
    },
    worker: context.worker,
  };
  const plan =
    mode === "cleanup"
      ? { _tag: "cleanup" as const, consumer: command, context }
      : undefined;
  const deploymentPlan =
    context.stage._tag === "preview"
      ? {
          _tag: "deploy" as const,
          consumer: command,
          context,
          issueNumber: context.stage.pullRequest,
          links,
        }
      : { _tag: "deploy" as const, consumer: command, context, links };
  const result = await runDeploymentOrchestration(
    plan ?? deploymentPlan,
    ports
  );
  if (result._tag === "err") {
    console.error(`::error::${result.error.message}`);
    return 1;
  }
  return 0;
};

if (import.meta.main) {
  process.exitCode = await main();
}
