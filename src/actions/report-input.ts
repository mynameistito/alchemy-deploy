import {
  DeploymentInputError,
  parseCommitSha,
  parseDeploymentStage,
  parseReportMode,
  parseWorkerName,
} from "../domain/deployment.ts";
import type { CommitSha, DeploymentStage, WorkerName } from "../domain/deployment.ts";
import type { DeploymentReportCommand, ReportContext } from "../application/deployment-report.ts";
import { err, ok } from "../shared/result.ts";
import type { Result } from "../shared/result.ts";

/** External environment consumed by the deployment-report action. */
export type ReportEnvironment = Readonly<Record<string, string | undefined>>;

/** Parsed action configuration and command. */
export interface ParsedReportInput {
  /** GitHub API origin. */
  readonly apiUrl: string;
  /** Command to execute. */
  readonly command: DeploymentReportCommand;
  /** Token used only by the GitHub adapter. */
  readonly token: string;
}

const required = (
  environment: ReportEnvironment,
  name: string,
): Result<string, DeploymentInputError> => {
  const value = environment[name]?.trim();
  return value ? ok(value) : err(new DeploymentInputError(name.toLowerCase(), "is required"));
};

const positiveInteger = (
  input: string | undefined,
  field: string,
): Result<number, DeploymentInputError> => {
  const value = Number(input);
  return Number.isSafeInteger(value) && value > 0
    ? ok(value)
    : err(new DeploymentInputError(field, "must be a positive integer"));
};

const outcome = (
  input: string | undefined,
): Result<"success" | "failure", DeploymentInputError> => {
  if (input === "success" || input === "failure") {
    return ok(input);
  }
  return err(new DeploymentInputError("deploy-outcome", "must be success or failure"));
};

const secureUrl = (
  input: string | undefined,
  field: string,
): Result<string, DeploymentInputError> => {
  const value = input?.trim();
  if (!value || /[\r\n]/u.test(value)) {
    return err(new DeploymentInputError(field, "must be an HTTPS URL"));
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname
      ? ok(value)
      : err(new DeploymentInputError(field, "must be an HTTPS URL"));
  } catch {
    return err(new DeploymentInputError(field, "must be an HTTPS URL"));
  }
};

const contextFrom = (
  environment: ReportEnvironment,
  stage: DeploymentStage,
  commitSha: CommitSha,
  worker: WorkerName,
): Result<ReportContext, DeploymentInputError> => {
  const owner = required(environment, "GITHUB_REPOSITORY_OWNER");
  const repositoryPath = required(environment, "GITHUB_REPOSITORY");
  const serverUrl = required(environment, "GITHUB_SERVER_URL");
  const runId = required(environment, "GITHUB_RUN_ID");
  if (owner._tag === "err") {
    return owner;
  }
  if (repositoryPath._tag === "err") {
    return repositoryPath;
  }
  if (serverUrl._tag === "err") {
    return serverUrl;
  }
  if (runId._tag === "err") {
    return runId;
  }
  const repository = repositoryPath.value.split("/").at(1);
  if (!repository) {
    return err(new DeploymentInputError("github_repository", "must be owner/repository"));
  }
  return ok({
    commitSha,
    owner: owner.value,
    repository,
    runUrl: `${serverUrl.value}/${repositoryPath.value}/actions/runs/${runId.value}`,
    stage,
    worker,
  });
};

/** Parse all action environment values into a legal report command. */
// eslint-disable-next-line complexity -- This is the single boundary parser for mode-specific action inputs.
export const parseReportEnvironment = (
  environment: ReportEnvironment,
  now: Date,
): Result<ParsedReportInput, DeploymentInputError> => {
  const mode = parseReportMode(environment.MODE);
  const stage = parseDeploymentStage(environment.STAGE, environment.PRODUCTION_STAGE ?? "prod");
  const commitSha = parseCommitSha(environment.DEPLOYMENT_SHA);
  const worker = parseWorkerName(environment.WORKER_NAME);
  const token = required(environment, "GITHUB_TOKEN");
  if (mode._tag === "err") {
    return mode;
  }
  if (stage._tag === "err") {
    return stage;
  }
  if (commitSha._tag === "err") {
    return commitSha;
  }
  if (worker._tag === "err") {
    return worker;
  }
  if (token._tag === "err") {
    return token;
  }
  const context = contextFrom(environment, stage.value, commitSha.value, worker.value);
  if (context._tag === "err") {
    return context;
  }

  let command: DeploymentReportCommand;
  if (mode.value === "create" || mode.value === "cleanup") {
    command = { _tag: mode.value, context: context.value };
  } else {
    const parsedOutcome = outcome(environment.DEPLOY_OUTCOME);
    const logsUrl = secureUrl(environment.LOGS_URL, "logs-url");
    if (parsedOutcome._tag === "err") {
      return parsedOutcome;
    }
    if (logsUrl._tag === "err") {
      return logsUrl;
    }
    const deploymentUrlInput = environment.DEPLOYMENT_URL?.trim();
    const deploymentUrl = deploymentUrlInput
      ? secureUrl(deploymentUrlInput, "deployment-url")
      : ok("");
    if (deploymentUrl._tag === "err") {
      return deploymentUrl;
    }
    if (mode.value === "complete") {
      const deploymentId = positiveInteger(environment.DEPLOYMENT_ID, "deployment-id");
      if (deploymentId._tag === "err") {
        return deploymentId;
      }
      command = {
        _tag: "complete",
        context: context.value,
        deploymentId: deploymentId.value,
        ...(deploymentUrl.value ? { deploymentUrl: deploymentUrl.value } : {}),
        logsUrl: logsUrl.value,
        outcome: parsedOutcome.value,
      };
    } else {
      const issueNumber = positiveInteger(environment.PULL_REQUEST_NUMBER, "pull-request-number");
      if (issueNumber._tag === "err") {
        return issueNumber;
      }
      command = {
        _tag: "comment",
        context: context.value,
        ...(deploymentUrl.value ? { deploymentUrl: deploymentUrl.value } : {}),
        issueNumber: issueNumber.value,
        logsUrl: logsUrl.value,
        outcome: parsedOutcome.value,
        updatedAt: now,
      };
    }
  }

  return ok({
    apiUrl: environment.GITHUB_API_URL ?? "https://api.github.com",
    command,
    token: token.value,
  });
};
