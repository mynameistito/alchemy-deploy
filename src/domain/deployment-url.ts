import type { DeploymentStage, WorkerName } from "./deployment.ts";
import { physicalWorkerName } from "./deployment.ts";
import { err, ok } from "../shared/result.ts";
import type { Result } from "../shared/result.ts";

const URL_CANDIDATE = /https:\/\/[^\s"'<>]+/gu;
const TRAILING_PUNCTUATION = /[),.;]+$/gu;

/** URL rules supplied by a consuming repository. */
export interface DeploymentUrlConfig {
  /** Exact production URL. */
  readonly productionUrl: string;
  /** Preview URL glob with `{worker}` and `{stage}` placeholders. */
  readonly previewUrlPattern: string;
}

/** A failure to parse URL configuration or find a matching deployed URL. */
export class DeploymentUrlError extends Error {
  readonly _tag = "DeploymentUrlError" as const;
  override readonly name = "DeploymentUrlError";
}

const escapeRegex = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const patternFor = (
  pattern: string,
  worker: WorkerName,
  stage: DeploymentStage,
): Result<RegExp, DeploymentUrlError> => {
  if (!pattern.includes("{worker}") || !pattern.includes("{stage}")) {
    return err(new DeploymentUrlError("preview-url-pattern must contain {worker} and {stage}"));
  }
  const escaped = escapeRegex(pattern)
    .replaceAll("\\{worker\\}", escapeRegex(worker))
    .replaceAll("\\{stage\\}", escapeRegex(stage.value))
    .replaceAll("\\*", "[^/]*");
  return ok(new RegExp(`^${escaped}$`, "u"));
};

const parseHttpsOrigin = (input: string, field: string): Result<string, DeploymentUrlError> => {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:") {
      return err(new DeploymentUrlError(`${field} must use HTTPS`));
    }
    return ok(url.origin);
  } catch (error) {
    return err(
      new DeploymentUrlError(
        `${field} is not a URL: ${error instanceof Error ? error.message : "unknown parse error"}`,
      ),
    );
  }
};

/** Resolve the deployed URL from configured production data or Alchemy logs. */
export const resolveDeploymentUrl = (
  log: string,
  stage: DeploymentStage,
  worker: WorkerName,
  config: DeploymentUrlConfig,
): Result<string, DeploymentUrlError> => {
  if (stage._tag === "production") {
    return parseHttpsOrigin(config.productionUrl, "production-url");
  }

  const matcher = patternFor(config.previewUrlPattern, worker, stage);
  if (matcher._tag === "err") {
    return matcher;
  }
  for (const rawCandidate of log.match(URL_CANDIDATE) ?? []) {
    const candidate = rawCandidate.replace(TRAILING_PUNCTUATION, "");
    const parsed = parseHttpsOrigin(candidate, "Alchemy output URL");
    if (parsed._tag === "ok" && matcher.value.test(parsed.value)) {
      return parsed;
    }
  }
  return err(
    new DeploymentUrlError(
      `Alchemy output did not contain a URL matching ${config.previewUrlPattern} for ${physicalWorkerName(worker, stage)}`,
    ),
  );
};

/** Build a stage-aware Cloudflare Worker logs URL. */
export const cloudflareLogsUrl = (
  accountId: string,
  worker: WorkerName,
  stage: DeploymentStage,
): Result<string, DeploymentUrlError> => {
  if (!accountId.trim()) {
    return err(new DeploymentUrlError("cloudflare-account-id is required"));
  }
  const service = encodeURIComponent(physicalWorkerName(worker, stage));
  const account = encodeURIComponent(accountId);
  return ok(
    `https://dash.cloudflare.com/?to=/${account}/workers/services/view/${service}/production/logs`,
  );
};
