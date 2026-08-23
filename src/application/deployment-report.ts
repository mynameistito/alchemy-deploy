import type {
  CommitSha,
  DeploymentStage,
  WorkerName,
} from "@/domain/deployment.ts";
import { isPreviewStage } from "@/domain/deployment.ts";
import {
  hasDeploymentCommentMarker,
  renderDeploymentComment,
} from "@/github/deployment-comment.ts";
import type { DeploymentCommentInput } from "@/github/deployment-comment.ts";
import type {
  GitHubApiError,
  GitHubDeploymentPort,
} from "@/github/github-api.ts";
import { err, ok } from "@/shared/result.ts";
import type { Result } from "@/shared/result.ts";

/** Shared context for all deployment-report modes. */
export interface ReportContext {
  /** GitHub commit being deployed. */
  readonly commitSha: CommitSha;
  /** Current GitHub repository owner. */
  readonly owner: string;
  /** Current GitHub repository name. */
  readonly repository: string;
  /** Current workflow diagnostics URL. */
  readonly runUrl: string;
  /** Parsed deployment stage. */
  readonly stage: DeploymentStage;
  /** Base Cloudflare Worker name. */
  readonly worker: WorkerName;
}

/** A command accepted by the deployment report application service. */
export type DeploymentReportCommand =
  | { readonly _tag: "create"; readonly context: ReportContext }
  | {
      readonly _tag: "complete";
      readonly context: ReportContext;
      readonly deploymentId: number;
      readonly deploymentUrl?: string;
      readonly logsUrl: string;
      readonly outcome: "success" | "failure";
    }
  | {
      readonly _tag: "comment";
      readonly context: ReportContext;
      readonly deploymentUrl?: string;
      readonly issueNumber: number;
      readonly logsUrl: string;
      readonly outcome: "success" | "failure";
      readonly updatedAt: Date;
    }
  | { readonly _tag: "cleanup"; readonly context: ReportContext };

/** Successful deployment-report outputs. */
export interface DeploymentReportOutput {
  /** Deployment ID created by create mode. */
  readonly deploymentId?: number;
  /** Number of deployment records deleted by cleanup mode. */
  readonly deletedDeployments?: number;
}

/** An application-policy failure. */
export class DeploymentReportError extends Error {
  readonly _tag = "DeploymentReportError" as const;
  override readonly cause: GitHubApiError | undefined;
  override readonly name = "DeploymentReportError";
  readonly deploymentId: number | undefined;

  /** Create a report error with its underlying expected failure. */
  constructor(message: string, cause?: GitHubApiError, deploymentId?: number) {
    super(message);
    this.cause = cause;
    this.deploymentId = deploymentId;
  }
}

const apiFailure = (
  error: GitHubApiError
): Result<never, DeploymentReportError> =>
  err(new DeploymentReportError(error.message, error));

const create = async (
  github: GitHubDeploymentPort,
  context: ReportContext
): Promise<Result<DeploymentReportOutput, DeploymentReportError>> => {
  const deployment = await github.createDeployment({
    environment: context.stage.value,
    production: context.stage._tag === "production",
    ref: context.commitSha,
  });
  if (deployment._tag === "err") {
    return apiFailure(deployment.error);
  }
  const status = await github.createDeploymentStatus({
    deploymentId: deployment.value,
    description: "Deploying the Alchemy stack",
    logUrl: context.runUrl,
    state: "in_progress",
  });
  return status._tag === "err"
    ? err(
        new DeploymentReportError(
          status.error.message,
          status.error,
          deployment.value
        )
      )
    : ok({ deploymentId: deployment.value });
};

const complete = async (
  github: GitHubDeploymentPort,
  command: Extract<DeploymentReportCommand, { readonly _tag: "complete" }>
): Promise<Result<DeploymentReportOutput, DeploymentReportError>> => {
  const statusRequest = {
    deploymentId: command.deploymentId,
    description:
      command.outcome === "success"
        ? "Deployment is live"
        : "Deployment failed",
    logUrl: command.logsUrl,
    state: command.outcome,
  };
  const status = await github.createDeploymentStatus(
    command.deploymentUrl
      ? { ...statusRequest, environmentUrl: command.deploymentUrl }
      : statusRequest
  );
  return status._tag === "err" ? apiFailure(status.error) : ok({});
};

const comment = async (
  github: GitHubDeploymentPort,
  command: Extract<DeploymentReportCommand, { readonly _tag: "comment" }>
): Promise<Result<DeploymentReportOutput, DeploymentReportError>> => {
  const comments = await github.listComments(command.issueNumber);
  if (comments._tag === "err") {
    return apiFailure(comments.error);
  }
  const existing = comments.value.find((item) =>
    hasDeploymentCommentMarker(item.body, command.context.stage)
  );
  const commentInput: DeploymentCommentInput = {
    commitSha: command.context.commitSha,
    logsUrl: command.logsUrl,
    outcome: command.outcome,
    owner: command.context.owner,
    repository: command.context.repository,
    runUrl: command.context.runUrl,
    stage: command.context.stage,
    updatedAt: command.updatedAt,
    worker: command.context.worker,
  };
  const body = renderDeploymentComment(
    command.deploymentUrl
      ? { ...commentInput, deploymentUrl: command.deploymentUrl }
      : commentInput
  );
  const result = existing
    ? await github.updateComment(existing.id, body)
    : await github.createComment(command.issueNumber, body);
  return result._tag === "err" ? apiFailure(result.error) : ok({});
};

const cleanup = async (
  github: GitHubDeploymentPort,
  context: ReportContext
): Promise<Result<DeploymentReportOutput, DeploymentReportError>> => {
  if (!isPreviewStage(context.stage)) {
    return err(
      new DeploymentReportError(
        `Refusing to clean up non-preview stage: ${context.stage.value}`
      )
    );
  }
  const deployments = await github.listDeployments(context.stage.value);
  if (deployments._tag === "err") {
    return apiFailure(deployments.error);
  }
  for (const deployment of deployments.value) {
    // oxlint-disable-next-line no-await-in-loop -- Each record must be inactive before that same record is deleted.
    const inactive = await github.createDeploymentStatus({
      deploymentId: deployment.id,
      description: "Pull request closed",
      state: "inactive",
    });
    if (inactive._tag === "err") {
      return apiFailure(inactive.error);
    }
    // oxlint-disable-next-line no-await-in-loop -- Cleanup stops on the first failure to preserve remaining evidence.
    const deleted = await github.deleteDeployment(deployment.id);
    if (deleted._tag === "err") {
      return apiFailure(deleted.error);
    }
  }
  return ok({ deletedDeployments: deployments.value.length });
};

/** Execute one deployment-report operation against its GitHub port. */
export const runDeploymentReport = (
  github: GitHubDeploymentPort,
  command: DeploymentReportCommand
): Promise<Result<DeploymentReportOutput, DeploymentReportError>> => {
  switch (command._tag) {
    case "create": {
      return create(github, command.context);
    }
    case "complete": {
      return complete(github, command);
    }
    case "comment": {
      return comment(github, command);
    }
    case "cleanup": {
      return cleanup(github, command.context);
    }
    default: {
      throw new Error("Unsupported deployment report command");
    }
  }
};
