import type { CommitSha, DeploymentStage, WorkerName } from "../domain/deployment.ts";
import { physicalWorkerName } from "../domain/deployment.ts";

const LOGO_URL =
  "https://raw.githubusercontent.com/mynameistito/alchemy-deploy/c8640f1df20812b904f5d3f9ee50c3fb1cb7e7c8/assets/alchemy.svg";

/** Values rendered into a deployment comment. */
export interface DeploymentCommentInput {
  /** Commit deployed. */
  readonly commitSha: CommitSha;
  /** Public deployment URL, when deployment succeeded. */
  readonly deploymentUrl?: string;
  /** Whether the deployment command succeeded. */
  readonly outcome: "success" | "failure";
  /** Repository owner. */
  readonly owner: string;
  /** Repository name. */
  readonly repository: string;
  /** GitHub Actions diagnostics URL. */
  readonly runUrl: string;
  /** Stage-specific Cloudflare logs URL. */
  readonly logsUrl: string;
  /** Parsed deployment stage. */
  readonly stage: DeploymentStage;
  /** Render timestamp. */
  readonly updatedAt: Date;
  /** Base Worker name. */
  readonly worker: WorkerName;
}

/** Return the exact hidden marker for a stage's durable PR comment. */
export const deploymentCommentMarker = (stage: DeploymentStage): string =>
  `<!-- alchemy-deploy:${stage.value} -->`;

/** Return whether a comment belongs to exactly the requested stage. */
export const hasDeploymentCommentMarker = (body: string | null, stage: DeploymentStage): boolean =>
  body?.split("\n").some((line) => line === deploymentCommentMarker(stage)) ?? false;

/** Render the stable deployment status comment. */
export const renderDeploymentComment = (input: DeploymentCommentInput): string => {
  const marker = deploymentCommentMarker(input.stage);
  const name = physicalWorkerName(input.worker, input.stage);
  const displayName =
    input.outcome === "success" && input.deploymentUrl ? `[${name}](${input.deploymentUrl})` : name;
  const commitUrl = `https://github.com/${input.owner}/${input.repository}/commit/${input.commitSha}`;
  const status = input.outcome === "success" ? "Deployment successful" : "Deployment failed";
  return [
    marker,
    `## Deploying with <a href="https://alchemy.run/"><img alt="Alchemy" src="${LOGO_URL}" width="16" height="16"></a> Alchemy`,
    "",
    "The latest deployment for this pull request.",
    "",
    "| Status | Name | Latest commit | Updated (UTC) |",
    "| - | - | - | - |",
    `| ${status}<br>[View Cloudflare logs](${input.logsUrl}) | ${displayName} | [${input.commitSha.slice(0, 8)}](${commitUrl}) | ${input.updatedAt.toISOString()} |`,
    "",
    `**Diagnostics:** [View GitHub Actions run](${input.runUrl})`,
  ].join("\n");
};
