import { appendFile } from "node:fs/promises";

import {
  deploymentPolicy,
  hasActiveDeployment,
} from "@/domain/deployment-policy.ts";
import type {
  PolicyInput,
  PolicyDecision,
} from "@/domain/deployment-policy.ts";
import { createGitHubApi } from "@/github/github-api.ts";
import type {
  GitHubDeployment,
  GitHubPolicyPort,
} from "@/github/github-api.ts";
import { err, ok } from "@/shared/result.ts";
import type { Result } from "@/shared/result.ts";

/** Environment available to the deployment-policy action boundary. */
export type PolicyEnvironment = Readonly<Record<string, string | undefined>>;

/** A safe output writer used by the action and its deterministic tests. */
export type PolicyOutput = (name: string, value: string) => Promise<void>;

class PolicyRuntimeError extends Error {
  readonly _tag = "PolicyRuntimeError" as const;
  override readonly name = "PolicyRuntimeError";
}

const integer = (value: string | undefined): number | undefined => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const required = (
  environment: PolicyEnvironment,
  name: string
): Result<string, PolicyRuntimeError> => {
  const value = environment[name]?.trim();
  return value ? ok(value) : err(new PolicyRuntimeError(`${name} is required`));
};

// oxlint-disable-next-line complexity -- This boundary keeps event-specific security gates on one policy path.
const resolve = async (
  environment: PolicyEnvironment,
  github: GitHubPolicyPort
): Promise<Result<PolicyDecision, PolicyRuntimeError>> => {
  const event = environment.EVENT_NAME;
  const repositoryId = integer(environment.REPOSITORY_ID);
  if (!repositoryId) {
    return err(
      new PolicyRuntimeError("REPOSITORY_ID must be a positive integer")
    );
  }
  if (event === "pull_request" && environment.EVENT_ACTION === "closed") {
    const number = integer(environment.PULL_REQUEST_NUMBER);
    const headRepositoryId = integer(
      environment.PULL_REQUEST_HEAD_REPOSITORY_ID
    );
    let cleanupInput: PolicyInput = {
      action: "closed",
      kind: "pull_request",
      repositoryId,
    };
    if (headRepositoryId !== undefined) {
      cleanupInput = { ...cleanupInput, headRepositoryId };
    }
    if (number !== undefined) {
      cleanupInput = { ...cleanupInput, number };
    }
    return ok(deploymentPolicy(cleanupInput));
  }
  if (event !== "workflow_run") {
    return ok({ kind: "noop", reason: "unsupported action event" });
  }
  if (environment.WORKFLOW_RUN_CONCLUSION !== "success") {
    return ok({ kind: "noop", reason: "CI did not succeed" });
  }
  const workflow = required(environment, "CI_WORKFLOW");
  const configuredBranch = required(environment, "PRODUCTION_BRANCH");
  const sha = required(environment, "DEPLOYMENT_SHA");
  if (workflow._tag === "err") {
    return workflow;
  }
  if (configuredBranch._tag === "err") {
    return configuredBranch;
  }
  if (sha._tag === "err") {
    return sha;
  }
  if (!/^[0-9a-f]{40}$/u.test(sha.value)) {
    return err(
      new PolicyRuntimeError(
        "DEPLOYMENT_SHA must be a 40-character hexadecimal SHA"
      )
    );
  }
  const workflowId = integer(environment.WORKFLOW_RUN_ID);
  if (!workflowId) {
    return err(
      new PolicyRuntimeError("WORKFLOW_RUN_ID must be a positive integer")
    );
  }
  const expectedWorkflow = await github.getWorkflowId(workflow.value);
  if (expectedWorkflow._tag === "err") {
    return err(new PolicyRuntimeError(expectedWorkflow.error.message));
  }
  if (expectedWorkflow.value !== workflowId) {
    return ok({ kind: "noop", reason: "configured workflow mismatch" });
  }
  let baseInput: PolicyInput = {
    conclusion: environment.WORKFLOW_RUN_CONCLUSION,
    kind: "workflow_run",
    productionBranch: configuredBranch.value,
    productionStage: environment.PRODUCTION_STAGE ?? "prod",
    sha: sha.value,
  };
  if (environment.WORKFLOW_RUN_BRANCH) {
    baseInput = { ...baseInput, branch: environment.WORKFLOW_RUN_BRANCH };
  }
  if (
    environment.WORKFLOW_RUN_EVENT === "push" ||
    environment.WORKFLOW_RUN_EVENT === "pull_request"
  ) {
    baseInput = { ...baseInput, event: environment.WORKFLOW_RUN_EVENT };
  }
  if (baseInput.event === "pull_request") {
    const number = integer(environment.PULL_REQUEST_NUMBER);
    if (!number) {
      return ok({ kind: "noop", reason: "invalid pull request number" });
    }
    const pullRequest = await github.getPullRequest(number);
    if (pullRequest._tag === "err") {
      return err(new PolicyRuntimeError(pullRequest.error.message));
    }
    const input: PolicyInput = { ...baseInput, pullRequest: pullRequest.value };
    const decision = deploymentPolicy(input);
    if (decision.kind !== "deploy") {
      return ok(decision);
    }
    const deployments = await github.listDeployments(decision.stage);
    if (deployments._tag === "err") {
      return err(new PolicyRuntimeError(deployments.error.message));
    }
    return hasActiveDeployment(
      deployments.value.filter(
        (
          deployment
        ): deployment is GitHubDeployment & {
          readonly sha: string;
          readonly state: string;
        } => Boolean(deployment.sha && deployment.state)
      ),
      decision.sha
    )
      ? ok({
          kind: "noop",
          reason: "deployment is already successful or in progress",
        })
      : ok(decision);
  } else if (baseInput.event === "push") {
    const current = await github.getBranchSha(configuredBranch.value);
    if (current._tag === "err") {
      return err(new PolicyRuntimeError(current.error.message));
    }
    const decision = deploymentPolicy({
      ...baseInput,
      currentMainSha: current.value,
    });
    if (decision.kind !== "deploy") {
      return ok(decision);
    }
    const deployments = await github.listDeployments(decision.stage);
    if (deployments._tag === "err") {
      return err(new PolicyRuntimeError(deployments.error.message));
    }
    return hasActiveDeployment(
      deployments.value.filter(
        (
          deployment
        ): deployment is GitHubDeployment & {
          readonly sha: string;
          readonly state: string;
        } => Boolean(deployment.sha && deployment.state)
      ),
      decision.sha
    )
      ? ok({
          kind: "noop",
          reason: "deployment is already successful or in progress",
        })
      : ok(decision);
  }
  return ok(deploymentPolicy(baseInput));
};

/** Resolve deployment or cleanup outputs through the production policy path. */
export const runDeploymentPolicy = async (
  environment: PolicyEnvironment,
  github: GitHubPolicyPort,
  output: PolicyOutput
): Promise<Result<PolicyDecision, PolicyRuntimeError>> => {
  await output("deploy", "false");
  await output("cleanup", "false");
  const decision = await resolve(environment, github);
  if (decision._tag === "err") {
    return decision;
  }
  if (decision.value.kind === "deploy") {
    await output("deploy", "true");
    await output("deployment-sha", decision.value.sha);
    await output(
      "preview",
      String(decision.value.stage !== (environment.PRODUCTION_STAGE ?? "prod"))
    );
    await output("stage", decision.value.stage);
    if (environment.PULL_REQUEST_NUMBER) {
      await output("pull-request-number", environment.PULL_REQUEST_NUMBER);
    }
  }
  if (decision.value.kind === "cleanup") {
    await output("cleanup", "true");
    await output("stage", decision.value.stage);
  }
  return decision;
};

const main = async (): Promise<number> => {
  const token = required(Bun.env, "GITHUB_TOKEN");
  const repository = required(Bun.env, "REPOSITORY");
  if (token._tag === "err") {
    console.error(`::error::${token.error.message}`);
    return 1;
  }
  if (repository._tag === "err") {
    console.error(`::error::${repository.error.message}`);
    return 1;
  }
  const [owner, name] = repository.value.split("/");
  if (!owner || !name) {
    console.error("::error::REPOSITORY must be owner/repository");
    return 1;
  }
  const github = createGitHubApi({
    apiUrl: Bun.env.GITHUB_API_URL ?? "https://api.github.com",
    owner,
    repository: name,
    token: token.value,
  });
  const outputPath = Bun.env.GITHUB_OUTPUT;
  const output: PolicyOutput = outputPath
    ? (key, value) => appendFile(outputPath, `${key}=${value}\n`, "utf-8")
    : () => Promise.resolve();
  const result = await runDeploymentPolicy(Bun.env, github, output);
  if (result._tag === "err") {
    console.error(`::error::${result.error.message}`);
    return 1;
  }
  return 0;
};

if (import.meta.main) {
  process.exitCode = await main();
}
