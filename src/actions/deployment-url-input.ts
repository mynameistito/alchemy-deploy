import type { DeploymentUrlConfig } from "@/domain/deployment-url.ts";
import {
  DeploymentInputError,
  parseDeploymentStage,
  parseWorkerName,
} from "@/domain/deployment.ts";
import type { DeploymentStage, WorkerName } from "@/domain/deployment.ts";
import { err, ok } from "@/shared/result.ts";
import type { Result } from "@/shared/result.ts";

/** External environment consumed by the deployment URL action. */
export type DeploymentUrlEnvironment = Readonly<
  Record<string, string | undefined>
>;

/** Parsed inputs required to resolve and publish deployment links. */
export interface ParsedDeploymentUrlInput {
  /** Cloudflare account ID used to build the logs link. */
  readonly accountId: string;
  /** Path to the captured Alchemy command output. */
  readonly logPath: string;
  /** Deployment command outcome. */
  readonly outcome: "success" | "failure";
  /** Parsed deployment stage. */
  readonly stage: DeploymentStage;
  /** Parsed base Worker name. */
  readonly worker: WorkerName;
  /** URL rules supplied by the consuming repository. */
  readonly urlConfig: DeploymentUrlConfig;
}

const required = (
  environment: DeploymentUrlEnvironment,
  name: string
): Result<string, DeploymentInputError> => {
  const value = environment[name]?.trim();
  return value
    ? ok(value)
    : err(new DeploymentInputError(name.toLowerCase(), "is required"));
};

/** Parse the action environment at the TypeScript runtime boundary. */
export const parseDeploymentUrlEnvironment = (
  environment: DeploymentUrlEnvironment
): Result<ParsedDeploymentUrlInput, DeploymentInputError> => {
  const accountId = required(environment, "ACCOUNT_ID");
  const logPath = required(environment, "LOG_PATH");
  const productionUrl = required(environment, "PRODUCTION_URL");
  const previewUrlPattern = required(environment, "PREVIEW_PATTERN");
  const outcome = environment.OUTCOME;
  const stage = parseDeploymentStage(
    environment.STAGE,
    environment.PRODUCTION_STAGE ?? "prod"
  );
  const worker = parseWorkerName(environment.WORKER);
  if (accountId._tag === "err") {
    return accountId;
  }
  if (logPath._tag === "err") {
    return logPath;
  }
  if (productionUrl._tag === "err") {
    return productionUrl;
  }
  if (previewUrlPattern._tag === "err") {
    return previewUrlPattern;
  }
  if (outcome !== "success" && outcome !== "failure") {
    return err(
      new DeploymentInputError("outcome", "must be success or failure")
    );
  }
  if (stage._tag === "err") {
    return stage;
  }
  if (worker._tag === "err") {
    return worker;
  }
  return ok({
    accountId: accountId.value,
    logPath: logPath.value,
    outcome,
    stage: stage.value,
    urlConfig: {
      previewUrlPattern: previewUrlPattern.value,
      productionUrl: productionUrl.value,
    },
    worker: worker.value,
  });
};
