import { z } from "zod";

import { err, ok } from "@/shared/result.ts";
import type { Result } from "@/shared/result.ts";

/** A GitHub issue comment used by deployment reporting. */
export interface GitHubComment {
  /** Database identifier. */
  readonly id: number;
  /** Markdown body, when present. */
  readonly body: string | null;
}

/** A GitHub deployment record. */
export interface GitHubDeployment {
  /** Database identifier. */
  readonly id: number;
  /** Commit SHA associated with the deployment. */
  readonly sha?: string;
  /** Latest deployment status. */
  readonly state?: string;
  /** Worker identity persisted by this action for isolated cleanup. */
  readonly worker?: string;
}

/** Pull request values required by deployment policy. */
export interface GitHubPullRequest {
  /** Pull request head repository identifier. */
  readonly headRepositoryId: number;
  /** Pull request number. */
  readonly number: number;
  /** Pull request base repository identifier. */
  readonly repositoryId: number;
  /** Pull request head commit SHA. */
  readonly sha: string;
  /** Pull request state. */
  readonly state: "open" | "closed";
}

/** An expected GitHub API failure with a safe response summary. */
export class GitHubApiError extends Error {
  readonly _tag = "GitHubApiError" as const;
  override readonly cause?: unknown;
  override readonly name = "GitHubApiError";
  readonly operation: string;
  readonly status: number | undefined;

  /** Create a classified GitHub API error. */
  constructor(
    operation: string,
    status: number | undefined,
    message: string,
    cause?: unknown
  ) {
    super(`${operation}: ${message}`);
    this.cause = cause;
    this.operation = operation;
    this.status = status;
  }
}

/** Values needed to create a GitHub deployment. */
export interface CreateDeploymentRequest {
  /** Deployment environment. */
  readonly environment: string;
  /** Full commit SHA. */
  readonly ref: string;
  /** Whether this is production. */
  readonly production: boolean;
  /** Worker identity used to scope cleanup. */
  readonly worker: string;
}

/** Values needed to create a deployment status. */
export interface CreateDeploymentStatusRequest {
  /** Deployment identifier. */
  readonly deploymentId: number;
  /** Human-readable status detail. */
  readonly description: string;
  /** Optional deployed environment URL. */
  readonly environmentUrl?: string;
  /** Diagnostics URL. */
  readonly logUrl?: string;
  /** GitHub deployment state. */
  readonly state: DeploymentState;
}

type DeploymentState = "in_progress" | "success" | "failure" | "inactive";

/** Operations consumed by deployment reporting. */
export interface GitHubDeploymentPort {
  /** Resolve a workflow file to its immutable GitHub workflow identifier. */
  readonly getWorkflowId?: (
    workflow: string
  ) => Promise<Result<number, GitHubApiError>>;
  /** Resolve a pull request's current trusted head. */
  readonly getPullRequest?: (
    issueNumber: number
  ) => Promise<Result<GitHubPullRequest, GitHubApiError>>;
  /** Resolve the current commit on a branch. */
  readonly getBranchSha?: (
    branch: string
  ) => Promise<Result<string, GitHubApiError>>;
  /** List deployment records and their latest statuses. */
  readonly listDeployments: (
    environment: string
  ) => Promise<Result<readonly GitHubDeployment[], GitHubApiError>>;
  /** Create a deployment and return its identifier. */
  readonly createDeployment: (
    request: CreateDeploymentRequest
  ) => Promise<Result<number, GitHubApiError>>;
  /** Create a status for a deployment. */
  readonly createDeploymentStatus: (
    request: CreateDeploymentStatusRequest
  ) => Promise<Result<true, GitHubApiError>>;
  /** Delete a deployment record. */
  readonly deleteDeployment: (
    deploymentId: number
  ) => Promise<Result<true, GitHubApiError>>;
  /** List every comment on an issue or pull request. */
  readonly listComments: (
    issueNumber: number
  ) => Promise<Result<readonly GitHubComment[], GitHubApiError>>;
  /** Create a pull-request comment. */
  readonly createComment: (
    issueNumber: number,
    body: string
  ) => Promise<Result<true, GitHubApiError>>;
  /** Update a pull-request comment. */
  readonly updateComment: (
    commentId: number,
    body: string
  ) => Promise<Result<true, GitHubApiError>>;
}

/** Read operations required by the deployment-policy action boundary. */
export interface GitHubPolicyPort extends GitHubDeploymentPort {
  readonly getWorkflowId: (
    workflow: string
  ) => Promise<Result<number, GitHubApiError>>;
  readonly getPullRequest: (
    issueNumber: number
  ) => Promise<Result<GitHubPullRequest, GitHubApiError>>;
  readonly getBranchSha: (
    branch: string
  ) => Promise<Result<string, GitHubApiError>>;
}

/** Configuration for the GitHub REST adapter. */
export interface GitHubApiConfig {
  /** API origin, normally GitHub's server URL plus `/api/v3` on GHES. */
  readonly apiUrl: string;
  /** Repository owner. */
  readonly owner: string;
  /** Repository name. */
  readonly repository: string;
  /** GitHub token, kept inside the adapter. */
  readonly token: string;
}

const githubObjectSchema = z.object({}).catchall(z.json());
type GitHubObject = z.infer<typeof githubObjectSchema>;
type GitHubRequestBody = z.infer<typeof githubObjectSchema>;
const CREATE_DEPLOYMENT = "create deployment";

const parseId = (input: GitHubObject): number | undefined => {
  const id = z.number().int().positive().safeParse(input.id);
  if (!id.success || !Number.isSafeInteger(id.data)) {
    return undefined;
  }
  return id.data;
};

const responseMessage = async (response: Response): Promise<string> => {
  const text = await response.text();
  const safeText = text.replaceAll(/\p{Cc}/gu, " ").trim();
  if (!safeText) {
    return response.statusText || "request failed";
  }
  try {
    const json = githubObjectSchema.safeParse(JSON.parse(safeText));
    const message = json.success
      ? z.string().safeParse(json.data.message)
      : undefined;
    if (message?.success) {
      return message.data;
    }
  } catch {
    return safeText.slice(0, 300);
  }
  return safeText.slice(0, 300);
};

const nextLink = (
  header: string | null,
  apiOrigin: string
): Result<{ readonly url?: string }, GitHubApiError> => {
  if (!header) {
    return ok({});
  }
  for (const part of header.split(",")) {
    const match = part.match(/<(?<url>[^>]+)>;\s*rel="next"/u);
    if (match?.groups?.url) {
      try {
        const next = new URL(match.groups.url);
        if (next.origin !== apiOrigin) {
          return err(
            new GitHubApiError(
              "paginate",
              undefined,
              `refusing cross-origin next link to ${next.origin}`
            )
          );
        }
        return ok({ url: next.href });
      } catch (error) {
        return err(
          new GitHubApiError(
            "paginate",
            undefined,
            "invalid next link URL",
            error
          )
        );
      }
    }
  }
  return ok({});
};

/** Create a REST-backed GitHub deployment adapter. */
export const createGitHubApi = (
  config: GitHubApiConfig,
  fetcher: typeof fetch = fetch
): GitHubPolicyPort => {
  const apiOrigin = new URL(config.apiUrl).origin;
  const root = `${config.apiUrl.replace(/\/$/u, "")}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}`;

  const request = async (
    operation: string,
    url: string,
    init: RequestInit = {}
  ): Promise<Result<Response, GitHubApiError>> => {
    try {
      const response = await fetcher(url, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${config.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...init.headers,
        },
      });
      if (!response.ok) {
        return err(
          new GitHubApiError(
            operation,
            response.status,
            await responseMessage(response)
          )
        );
      }
      return ok(response);
    } catch (error) {
      return err(
        new GitHubApiError(
          operation,
          undefined,
          "network request failed",
          error
        )
      );
    }
  };

  const write = (
    operation: string,
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: GitHubRequestBody
  ): Promise<Result<Response, GitHubApiError>> => {
    const init: RequestInit = { method };
    if (body) {
      init.body = JSON.stringify(body);
    }
    return request(operation, `${root}${path}`, init);
  };

  const paginate = async <T>(
    operation: string,
    initialUrl: string,
    parse: (input: GitHubObject) => T | undefined
  ): Promise<Result<readonly T[], GitHubApiError>> => {
    const values: T[] = [];
    let url: string | undefined = initialUrl;
    while (url) {
      // oxlint-disable-next-line no-await-in-loop -- GitHub's next page URL is supplied by the preceding response.
      const response = await request(operation, url);
      if (response._tag === "err") {
        return response;
      }
      let json: unknown;
      try {
        // oxlint-disable-next-line no-await-in-loop -- Parsing belongs to the sequential pagination request.
        json = await response.value.json();
      } catch (error) {
        return err(
          new GitHubApiError(
            operation,
            response.value.status,
            "invalid JSON",
            error
          )
        );
      }
      if (!Array.isArray(json)) {
        return err(
          new GitHubApiError(
            operation,
            response.value.status,
            "expected an array response"
          )
        );
      }
      for (const item of json) {
        const object = githubObjectSchema.safeParse(item);
        if (!object.success) {
          return err(
            new GitHubApiError(
              operation,
              response.value.status,
              "response item was not an object"
            )
          );
        }
        const parsed = parse(object.data);
        if (!parsed) {
          return err(
            new GitHubApiError(
              operation,
              response.value.status,
              "response item did not match the expected shape"
            )
          );
        }
        values.push(parsed);
      }
      const next = nextLink(response.value.headers.get("link"), apiOrigin);
      if (next._tag === "err") {
        return next;
      }
      const { url: nextPageUrl } = next.value;
      url = nextPageUrl;
    }
    return ok(values);
  };

  return {
    createComment: async (issueNumber, body) => {
      const response = await write(
        "create comment",
        `/issues/${issueNumber}/comments`,
        "POST",
        {
          body,
        }
      );
      return response._tag === "ok" ? ok(true) : response;
    },
    createDeployment: async (deployment) => {
      const response = await write(CREATE_DEPLOYMENT, "/deployments", "POST", {
        auto_merge: false,
        description: `Alchemy ${deployment.environment} deployment`,
        environment: deployment.environment,
        payload: { worker: deployment.worker },
        production_environment: deployment.production,
        ref: deployment.ref,
        required_contexts: [],
        transient_environment: !deployment.production,
      });
      if (response._tag === "err") {
        return response;
      }
      let json: unknown;
      try {
        json = await response.value.json();
      } catch (error) {
        return err(
          new GitHubApiError(
            CREATE_DEPLOYMENT,
            response.value.status,
            "invalid JSON",
            error
          )
        );
      }
      const object = githubObjectSchema.safeParse(json);
      const id = object.success ? parseId(object.data) : undefined;
      return id
        ? ok(id)
        : err(
            new GitHubApiError(
              CREATE_DEPLOYMENT,
              response.value.status,
              "response did not contain a numeric id"
            )
          );
    },
    createDeploymentStatus: async (status) => {
      const statusBody = {
        description: status.description,
        state: status.state,
      };
      if (status.environmentUrl) {
        Object.assign(statusBody, { environment_url: status.environmentUrl });
      }
      if (status.logUrl) {
        Object.assign(statusBody, { log_url: status.logUrl });
      }
      const response = await write(
        "create deployment status",
        `/deployments/${status.deploymentId}/statuses`,
        "POST",
        statusBody
      );
      return response._tag === "ok" ? ok(true) : response;
    },
    deleteDeployment: async (deploymentId) => {
      const response = await write(
        "delete deployment",
        `/deployments/${deploymentId}`,
        "DELETE"
      );
      return response._tag === "ok" ? ok(true) : response;
    },
    getBranchSha: async (branch) => {
      const response = await request(
        "get branch",
        `${root}/branches/${encodeURIComponent(branch)}`
      );
      if (response._tag === "err") {
        return response;
      }
      const json = githubObjectSchema.safeParse(await response.value.json());
      const commit = json.success
        ? githubObjectSchema.safeParse(json.data.commit)
        : undefined;
      const sha = commit?.success
        ? z.string().length(40).safeParse(commit.data.sha)
        : undefined;
      return sha?.success && sha.data.length === 40
        ? ok(sha.data)
        : err(
            new GitHubApiError(
              "get branch",
              response.value.status,
              "response did not contain a branch SHA"
            )
          );
    },
    getPullRequest: async (issueNumber) => {
      const response = await request(
        "get pull request",
        `${root}/pulls/${issueNumber}`
      );
      if (response._tag === "err") {
        return response;
      }
      const json = githubObjectSchema.safeParse(await response.value.json());
      if (!json.success) {
        return err(
          new GitHubApiError(
            "get pull request",
            response.value.status,
            "response was not an object"
          )
        );
      }
      const head = githubObjectSchema.safeParse(json.data.head);
      const base = githubObjectSchema.safeParse(json.data.base);
      const headRepository = head.success
        ? githubObjectSchema.safeParse(head.data.repo)
        : undefined;
      const baseRepository = base.success
        ? githubObjectSchema.safeParse(base.data.repo)
        : undefined;
      const number = z.number().int().positive().safeParse(json.data.number);
      const state = z.enum(["open", "closed"]).safeParse(json.data.state);
      const sha = head.success
        ? z.string().length(40).safeParse(head.data.sha)
        : undefined;
      const headRepositoryId = headRepository?.success
        ? parseId(headRepository.data)
        : undefined;
      const repositoryId = baseRepository?.success
        ? parseId(baseRepository.data)
        : undefined;
      return number.success &&
        state.success &&
        sha?.success &&
        headRepositoryId &&
        repositoryId
        ? ok({
            headRepositoryId,
            number: number.data,
            repositoryId,
            sha: sha.data,
            state: state.data,
          })
        : err(
            new GitHubApiError(
              "get pull request",
              response.value.status,
              "response did not match the expected shape"
            )
          );
    },
    getWorkflowId: async (workflow) => {
      const response = await request(
        "get workflow",
        `${config.apiUrl.replace(/\/$/u, "")}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/actions/workflows/${encodeURIComponent(workflow)}`
      );
      if (response._tag === "err") {
        return response;
      }
      const json = githubObjectSchema.safeParse(await response.value.json());
      const id = json.success ? parseId(json.data) : undefined;
      return id
        ? ok(id)
        : err(
            new GitHubApiError(
              "get workflow",
              response.value.status,
              "response did not contain a workflow ID"
            )
          );
    },
    listComments: (issueNumber) =>
      paginate(
        "list comments",
        `${root}/issues/${issueNumber}/comments?per_page=100`,
        (input) => {
          const id = parseId(input);
          if (!id) {
            return;
          }
          const body = z.string().nullable().safeParse(input.body);
          return body.success ? { body: body.data, id } : undefined;
        }
      ),
    listDeployments: async (environment) => {
      const deployments = await paginate(
        "list deployments",
        `${root}/deployments?environment=${encodeURIComponent(environment)}&per_page=100`,
        (input) => {
          const id = parseId(input);
          const sha = z.string().length(40).safeParse(input.sha);
          if (id === undefined || !sha.success) {
            return;
          }
          const payload = githubObjectSchema.safeParse(input.payload);
          const worker = payload.success
            ? z.string().safeParse(payload.data.worker)
            : null;
          const deployment = { id, sha: sha.data };
          return worker?.success
            ? { ...deployment, worker: worker.data }
            : deployment;
        }
      );
      if (deployments._tag === "err") {
        return deployments;
      }
      const values: GitHubDeployment[] = [];
      for (const deployment of deployments.value) {
        // oxlint-disable-next-line no-await-in-loop -- The latest status belongs to this deployment.
        const response = await request(
          "list deployment statuses",
          `${root}/deployments/${deployment.id}/statuses?per_page=1`
        );
        if (response._tag === "err") {
          return response;
        }
        // oxlint-disable-next-line no-await-in-loop -- The response is for the current deployment.
        const json: unknown = await response.value.json();
        const statuses = z.array(githubObjectSchema).safeParse(json);
        const state = statuses.success
          ? z.string().safeParse(statuses.data[0]?.state)
          : undefined;
        if (!state?.success) {
          return err(
            new GitHubApiError(
              "list deployment statuses",
              response.value.status,
              "response did not contain a deployment status"
            )
          );
        }
        values.push({ ...deployment, state: state.data });
      }
      return ok(values);
    },
    updateComment: async (commentId, body) => {
      const response = await write(
        "update comment",
        `/issues/comments/${commentId}`,
        "PATCH",
        {
          body,
        }
      );
      return response._tag === "ok" ? ok(true) : response;
    },
  };
};
