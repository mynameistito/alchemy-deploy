import { appendFile } from "node:fs/promises";
import { runDeploymentReport } from "../application/deployment-report.ts";
import { parseReportEnvironment } from "./report-input.ts";
import { createGitHubApi } from "../github/github-api.ts";

const setOutput = async (name: string, value: string): Promise<void> => {
  const path = Bun.env.GITHUB_OUTPUT;
  if (!path) {
    return;
  }
  await appendFile(path, `${name}=${value}\n`, "utf-8");
};

const main = async (): Promise<number> => {
  const parsed = parseReportEnvironment(Bun.env, new Date());
  if (parsed._tag === "err") {
    console.error(`::error::Invalid deployment-report input: ${parsed.error.message}`);
    return 1;
  }
  const { context } = parsed.value.command;
  const github = createGitHubApi({
    apiUrl: parsed.value.apiUrl,
    owner: context.owner,
    repository: context.repository,
    token: parsed.value.token,
  });
  const result = await runDeploymentReport(github, parsed.value.command);
  if (result._tag === "err") {
    if (result.error.deploymentId) {
      await setOutput("deployment-id", String(result.error.deploymentId));
    }
    console.error(`::error::Deployment reporting failed: ${result.error.message}`);
    return 1;
  }
  if (result.value.deploymentId) {
    await setOutput("deployment-id", String(result.value.deploymentId));
  }
  if (result.value.deletedDeployments !== undefined) {
    await setOutput("deleted-deployments", String(result.value.deletedDeployments));
  }
  return 0;
};

process.exitCode = await main();
