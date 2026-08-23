import { appendFile, readFile } from "node:fs/promises";

import type { DeploymentUrlEnvironment } from "@/actions/deployment-url-input.ts";
import { parseDeploymentUrlEnvironment } from "@/actions/deployment-url-input.ts";
import {
  cloudflareLogsUrl,
  resolveDeploymentUrl,
} from "@/domain/deployment-url.ts";

const setOutput = async (
  path: string | undefined,
  name: string,
  value: string
): Promise<void> => {
  if (path) {
    await appendFile(path, `${name}=${value}\n`, "utf-8");
  }
};

/** Resolve deployment links and write them to the GitHub Actions output file. */
export const runDeploymentUrl = async (
  environment: DeploymentUrlEnvironment
): Promise<number> => {
  const parsed = parseDeploymentUrlEnvironment(environment);
  if (parsed._tag === "err") {
    console.error(
      `::error::Invalid deployment URL input: ${parsed.error.message}`
    );
    return 1;
  }

  const logs = cloudflareLogsUrl(
    parsed.value.accountId,
    parsed.value.worker,
    parsed.value.stage
  );
  if (logs._tag === "err") {
    console.error(`::error::${logs.error.message}`);
    return 1;
  }
  await setOutput(environment.GITHUB_OUTPUT, "logs-url", logs.value);

  if (parsed.value.outcome !== "success") {
    return 0;
  }

  let log: string;
  try {
    log = await readFile(parsed.value.logPath, "utf-8");
  } catch (error) {
    console.error(
      `::error::Could not read Alchemy deployment output: ${error instanceof Error ? error.message : "unknown error"}`
    );
    return 1;
  }
  const deployment = resolveDeploymentUrl(
    log,
    parsed.value.stage,
    parsed.value.worker,
    parsed.value.urlConfig
  );
  if (deployment._tag === "err") {
    console.error(`::error::${deployment.error.message}`);
    return 1;
  }
  await setOutput(
    environment.GITHUB_OUTPUT,
    "deployment-url",
    deployment.value
  );
  return 0;
};

if (import.meta.main) {
  process.exitCode = await runDeploymentUrl(Bun.env);
}
