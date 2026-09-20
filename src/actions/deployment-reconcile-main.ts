import { diagnostic, required, runConsumerCommand } from "@/actions/deployment-command.ts";
import type { ConsumerCommand } from "@/application/deployment-orchestration.ts";
import { runDeploymentReport } from "@/application/deployment-report.ts";
import type { ReportContext } from "@/application/deployment-report.ts";
import { runPreviewReconcile } from "@/application/preview-reconcile.ts";
import type { PreviewCandidate } from "@/domain/preview-reconcile.ts";
import {
  parseCommitSha,
  parseDeploymentStage,
  parseWorkerName,
} from "@/domain/deployment.ts";
import { previewCandidates } from "@/domain/preview-reconcile.ts";
import { createGitHubApi } from "@/github/github-api.ts";
import { err, ok } from "@/shared/result.ts";
import type { Result } from "@/shared/result.ts";

const fail = (error: Error): number => {
  console.error(`::error::${error.message}`);
  return 1;
};

const main = async (): Promise<number> => {
  const token = required("GITHUB_TOKEN");
  if (token._tag === "err") {
    return fail(token.error);
  }
  const apiUrl = required("GITHUB_API_URL");
  if (apiUrl._tag === "err") {
    return fail(apiUrl.error);
  }
  const repository = required("GITHUB_REPOSITORY");
  if (repository._tag === "err") {
    return fail(repository.error);
  }
  const runId = required("GITHUB_RUN_ID");
  if (runId._tag === "err") {
    return fail(runId.error);
  }
  const serverUrl = required("GITHUB_SERVER_URL");
  if (serverUrl._tag === "err") {
    return fail(serverUrl.error);
  }
  const worker = parseWorkerName(Bun.env.WORKER_NAME);
  if (worker._tag === "err") {
    return fail(worker.error);
  }
  const [owner, name] = repository.value.split("/");
  if (!owner || !name) {
    console.error("::error::GITHUB_REPOSITORY must be owner/repository");
    return 1;
  }
  const productionStage = Bun.env.PRODUCTION_STAGE ?? "prod";
  const destroyCommand = Bun.env.DESTROY_COMMAND ?? "";
  const logDirectory = Bun.env.RUNNER_TEMP ?? ".";
  const runUrl = `${serverUrl.value}/${repository.value}/actions/runs/${runId.value}`;
  const github = createGitHubApi({
    apiUrl: apiUrl.value,
    owner,
    repository: name,
    token: token.value,
  });

  const cleanup = async (
    candidate: PreviewCandidate
  ): Promise<Result<true, Error>> => {
    const stage = parseDeploymentStage(candidate.stage, productionStage);
    if (stage._tag === "err") {
      return err(new Error(stage.error.message));
    }
    const commitSha = parseCommitSha(candidate.sha);
    if (commitSha._tag === "err") {
      return err(new Error(commitSha.error.message));
    }
    const context: ReportContext = {
      commitSha: commitSha.value,
      owner,
      repository: name,
      runUrl,
      stage: stage.value,
      worker: worker.value,
    };
    const command: ConsumerCommand = {
      command: destroyCommand,
      environment: { STAGE: stage.value.value },
      logPath: `${logDirectory}/alchemy-${stage.value.value}.log`,
    };
    const outcome = await runConsumerCommand(command);
    if (outcome._tag === "err" || outcome.value === "failure") {
      return err(
        new Error(`Preview destroy command failed for ${candidate.stage}`)
      );
    }
    const report = await runDeploymentReport(github, {
      _tag: "cleanup",
      context,
    });
    return report._tag === "err"
      ? err(new Error(report.error.message))
      : ok(true);
  };

  const result = await runPreviewReconcile({
    candidates: async () => {
      const deployments = await github.listPreviewDeployments();
      return deployments._tag === "err"
        ? err(new Error(deployments.error.message))
        : ok(previewCandidates(deployments.value));
    },
    cleanup,
    diagnostic,
    isPullRequestOpen: async (pullRequest) => {
      const pull = await github.getPullRequest(pullRequest);
      return pull._tag === "err"
        ? err(new Error(pull.error.message))
        : ok(pull.value.state === "open");
    },
  });
  if (result._tag === "err") {
    return fail(result.error);
  }
  const { failed, reconciled, skipped } = result.value;
  console.error(
    `Preview reconcile: ${reconciled} destroyed, ${skipped} skipped, ${failed} failed.`
  );
  return failed > 0 ? 1 : 0;
};

if (import.meta.main) {
  process.exitCode = await main();
}
