/** Deployment fields used to discover preview stages. */
export interface DeploymentEnvironment {
  /** GitHub deployment environment, expected to be a preview stage. */
  readonly environment: string;
  /** Commit SHA recorded on the deployment. */
  readonly sha: string;
}

/** A preview stage discovered from GitHub deployment records. */
export interface PreviewCandidate {
  /** Pull request number encoded by the stage. */
  readonly pullRequest: number;
  /** Commit SHA recorded on the newest deployment for the stage. */
  readonly sha: string;
  /** Preview stage value, `pr-<number>`. */
  readonly stage: string;
}

const PREVIEW_ENVIRONMENT = /^pr-[1-9]\d*$/u;
const PREVIEW_PREFIX = "pr-";

/**
 * Distinct preview stages present in deployment records, newest first.
 *
 * Input ordering is preserved, so GitHub's newest-first deployment listing
 * yields the newest deployment of each stage.
 */
export const previewCandidates = (
  deployments: readonly DeploymentEnvironment[]
): readonly PreviewCandidate[] => {
  const candidates: PreviewCandidate[] = [];
  const seen = new Set<string>();
  for (const deployment of deployments) {
    if (
      !PREVIEW_ENVIRONMENT.test(deployment.environment) ||
      seen.has(deployment.environment)
    ) {
      continue;
    }
    seen.add(deployment.environment);
    candidates.push({
      pullRequest: Number(deployment.environment.slice(PREVIEW_PREFIX.length)),
      sha: deployment.sha,
      stage: deployment.environment,
    });
  }
  return candidates;
};
