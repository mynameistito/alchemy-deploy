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
  /** Create a deployment and return its identifier. */
  readonly createDeployment: (
    request: CreateDeploymentRequest
  ) => Promise<Result<number, GitHubApiError>>;
  /** Create a status for a deployment. */
  readonly createDeploymentStatus: (
    request: CreateDeploymentStatusRequest
  ) => Promise<Result<true, GitHubApiError>>;
  /** List every deployment in an environment. */
  readonly listDeployments: (
    environment: string
  ) => Promise<Result<readonly GitHubDeployment[], GitHubApiError>>;
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
): GitHubDeploymentPort => {
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
    listDeployments: (environment) =>
      paginate(
        "list deployments",
        `${root}/deployments?environment=${encodeURIComponent(environment)}&per_page=100`,
        (input) => {
          const id = parseId(input);
          return id ? { id } : undefined;
        }
      ),
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
