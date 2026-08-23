import type {
  DeploymentReportCommand,
  DeploymentReportOutput,
  ReportContext,
} from "@/application/deployment-report.ts";
import { DeploymentReportError } from "@/application/deployment-report.ts";
import type { DeploymentUrlConfig } from "@/domain/deployment-url.ts";
import type { DeploymentStage, WorkerName } from "@/domain/deployment.ts";
import type { Result } from "@/shared/result.ts";

/** The opaque consumer command and its isolated process environment. */
export interface ConsumerCommand {
  /** Command string interpreted by Bash. */
  readonly command: string;
  /** Environment additions visible to the consumer command. */
  readonly environment: Readonly<Record<string, string>>;
  /** File receiving the streamed combined command output. */
  readonly logPath: string;
}

/** The result of a consumer command, independent of process details. */
export type ConsumerOutcome = "success" | "failure";

/** Inputs required to resolve deployment and diagnostic links. */
export interface DeploymentLinkInput {
  /** Log file produced by the consumer command. */
  readonly logPath: string;
  /** Consumer command outcome. */
  readonly outcome: ConsumerOutcome;
  /** URL configuration supplied by the consuming repository. */
  readonly urlConfig: DeploymentUrlConfig;
  /** Cloudflare account identifier. */
  readonly accountId: string;
  /** Deployment stage. */
  readonly stage: DeploymentStage;
  /** Logical worker name. */
  readonly worker: WorkerName;
}

/** Links emitted after a consumer command runs. */
export interface DeploymentLinks {
  /** Cloudflare logs URL. */
  readonly logsUrl: string;
  /** Resolved deployed URL, when one is available. */
  readonly deploymentUrl?: string;
}

/** A typed lifecycle plan; no combination of phase booleans is representable. */
export type DeploymentOrchestrationPlan =
  | { readonly _tag: "noop" }
  | {
      readonly _tag: "deploy";
      readonly context: ReportContext;
      readonly consumer: ConsumerCommand;
      readonly links: DeploymentLinkInput;
      readonly issueNumber?: number;
    }
  | {
      readonly _tag: "cleanup";
      readonly context: ReportContext;
      readonly consumer: ConsumerCommand;
    };

/** Ports used by the orchestration service. */
export interface DeploymentOrchestrationPorts {
  /** Recheck the trusted commit immediately before consumer execution. */
  readonly recheck: () => Promise<Result<true, Error>>;
  /** Execute one typed deployment-report command. */
  readonly report: (
    command: DeploymentReportCommand
  ) => Promise<Result<DeploymentReportOutput, Error>>;
  /** Execute an opaque consumer command through the process adapter. */
  readonly consumer: (
    command: ConsumerCommand
  ) => Promise<Result<ConsumerOutcome, Error>>;
  /** Resolve logs and deployment links through the URL adapter. */
  readonly links: (
    input: DeploymentLinkInput
  ) => Promise<Result<DeploymentLinks, Error>>;
  /** Preserve diagnostics when a later phase cannot report them to GitHub. */
  readonly diagnostic: (message: string) => Promise<void>;
}

/** Final observable state of a lifecycle execution. */
export interface DeploymentOrchestrationOutput {
  /** Lifecycle phase selected by policy. */
  readonly phase: DeploymentOrchestrationPlan["_tag"];
  /** Deployment ID when GitHub created or retained one. */
  readonly deploymentId?: number;
  /** Resolved links from the consumer output. */
  readonly links?: DeploymentLinks;
}

/** Expected failure from a lifecycle phase. */
export class DeploymentOrchestrationError extends Error {
  readonly _tag = "DeploymentOrchestrationError" as const;
  override readonly name = "DeploymentOrchestrationError";
  override readonly cause: Error | undefined;
  readonly phase: Exclude<DeploymentOrchestrationPlan["_tag"], "noop">;
  readonly deploymentId: number | undefined;

  /** Create a failure that retains the deployment record when one exists. */
  constructor(
    phase: Exclude<DeploymentOrchestrationPlan["_tag"], "noop">,
    message: string,
    deploymentId: number | undefined,
    cause?: Error
  ) {
    super(message);
    this.phase = phase;
    this.deploymentId = deploymentId;
    this.cause = cause;
  }
}

const failure = (
  phase: "deploy" | "cleanup",
  error: Error,
  deploymentId?: number
): Result<never, DeploymentOrchestrationError> => ({
  _tag: "err",
  error: new DeploymentOrchestrationError(
    phase,
    error.message,
    deploymentId,
    error
  ),
});

const reportFailure = (
  phase: "deploy" | "cleanup",
  result: Result<DeploymentReportOutput, Error>,
  deploymentId?: number
): Result<never, DeploymentOrchestrationError> =>
  result._tag === "err"
    ? failure(phase, result.error, deploymentId)
    : failure(
        phase,
        new Error("deployment report returned no output"),
        deploymentId
      );

const successful = (
  command: Result<ConsumerOutcome, Error>,
  deploymentUrl: string | undefined
): boolean =>
  command._tag === "ok" &&
  command.value === "success" &&
  deploymentUrl !== undefined;

const runDeploy = async (
  plan: Extract<DeploymentOrchestrationPlan, { _tag: "deploy" }>,
  ports: DeploymentOrchestrationPorts
): Promise<
  Result<DeploymentOrchestrationOutput, DeploymentOrchestrationError>
> => {
  const recheck = await ports.recheck();
  if (recheck._tag === "err") {
    await ports.diagnostic(
      `Deployment blocked by stale policy recheck: ${recheck.error.message}`
    );
    return failure("deploy", recheck.error);
  }

  const created = await ports.report({
    _tag: "create",
    context: plan.context,
  });
  if (created._tag === "err") {
    const deploymentId =
      created.error instanceof DeploymentReportError
        ? created.error.deploymentId
        : undefined;
    await ports.diagnostic(
      `Deployment reporting failed: ${created.error.message}`
    );
    return reportFailure("deploy", created, deploymentId);
  }
  const { deploymentId } = created.value;
  if (deploymentId === undefined) {
    return failure(
      "deploy",
      new Error("deployment report did not create a deployment")
    );
  }

  const command = await ports.consumer(plan.consumer);
  const outcome = command._tag === "ok" ? command.value : "failure";
  const links = await ports.links({ ...plan.links, outcome });
  if (links._tag === "err") {
    await ports.diagnostic(
      `Deployment link resolution failed: ${links.error.message}`
    );
    const complete = await ports.report({
      _tag: "complete",
      context: plan.context,
      deploymentId,
      logsUrl: plan.context.runUrl,
      outcome: "failure",
    });
    if (complete._tag === "err") {
      return reportFailure("deploy", complete, deploymentId);
    }
    return failure("deploy", links.error, deploymentId);
  }
  const resolvedLinks = links.value;
  let completeCommand: Extract<DeploymentReportCommand, { _tag: "complete" }> =
    {
      _tag: "complete",
      context: plan.context,
      deploymentId,
      logsUrl: resolvedLinks.logsUrl,
      outcome: successful(command, resolvedLinks.deploymentUrl)
        ? "success"
        : "failure",
    };
  if (resolvedLinks.deploymentUrl) {
    completeCommand = {
      ...completeCommand,
      deploymentUrl: resolvedLinks.deploymentUrl,
    };
  }
  const complete = await ports.report(completeCommand);
  if (complete._tag === "err") {
    return reportFailure("deploy", complete, deploymentId);
  }
  if (plan.issueNumber !== undefined && plan.context.stage._tag === "preview") {
    let commentCommand: Extract<DeploymentReportCommand, { _tag: "comment" }> =
      {
        _tag: "comment",
        context: plan.context,
        issueNumber: plan.issueNumber,
        logsUrl: resolvedLinks.logsUrl,
        outcome: successful(command, resolvedLinks.deploymentUrl)
          ? "success"
          : "failure",
        updatedAt: new Date(),
      };
    if (resolvedLinks.deploymentUrl) {
      commentCommand = {
        ...commentCommand,
        deploymentUrl: resolvedLinks.deploymentUrl,
      };
    }
    const comment = await ports.report(commentCommand);
    if (comment._tag === "err") {
      return reportFailure("deploy", comment, deploymentId);
    }
  }
  if (command._tag === "err") {
    return failure("deploy", command.error, deploymentId);
  }
  if (command.value === "failure") {
    return failure(
      "deploy",
      new Error("consumer deploy command failed"),
      deploymentId
    );
  }
  return {
    _tag: "ok",
    value: { deploymentId, links: links.value, phase: "deploy" },
  };
};

const runCleanup = async (
  plan: Extract<DeploymentOrchestrationPlan, { _tag: "cleanup" }>,
  ports: DeploymentOrchestrationPorts
): Promise<
  Result<DeploymentOrchestrationOutput, DeploymentOrchestrationError>
> => {
  const command = await ports.consumer(plan.consumer);
  if (command._tag === "err") {
    await ports.diagnostic(
      `Preview cleanup failed for ${plan.context.stage.value}: ${command.error.message}`
    );
    return failure("cleanup", command.error);
  }
  if (command.value === "failure") {
    await ports.diagnostic(
      `Preview cleanup failed for ${plan.context.stage.value}`
    );
    return failure("cleanup", new Error("consumer cleanup command failed"));
  }
  const report = await ports.report({
    _tag: "cleanup",
    context: plan.context,
  });
  if (report._tag === "err") {
    await ports.diagnostic(
      `Preview cleanup reporting failed for ${plan.context.stage.value}: ${report.error.message}`
    );
    return reportFailure("cleanup", report);
  }
  return { _tag: "ok", value: { phase: "cleanup" } };
};

/** Execute a policy-selected deployment lifecycle in its required order. */
export const runDeploymentOrchestration = (
  plan: DeploymentOrchestrationPlan,
  ports: DeploymentOrchestrationPorts
): Promise<
  Result<DeploymentOrchestrationOutput, DeploymentOrchestrationError>
> => {
  switch (plan._tag) {
    case "noop": {
      return Promise.resolve({ _tag: "ok", value: { phase: "noop" } });
    }
    case "cleanup": {
      return runCleanup(plan, ports);
    }
    case "deploy": {
      return runDeploy(plan, ports);
    }
    default: {
      throw new Error("Unsupported deployment orchestration plan");
    }
  }
};
