import { afterEach, describe, expect, test } from "bun:test";
import { createGitHubApi } from "../github-api.ts";

const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe("GitHub API adapter", () => {
  test("follows Link pagination for comments", async () => {
    const serverUrl = { value: "" };
    const server = Bun.serve({
      fetch(request): Response {
        const url = new URL(request.url);
        if (url.searchParams.get("page") === "2") {
          return Response.json([{ body: "second", id: 2 }]);
        }
        return Response.json([{ body: "first", id: 1 }], {
          headers: {
            Link: `<${serverUrl.value}repos/owner/repo/issues/42/comments?per_page=100&page=2>; rel="next"`,
          },
        });
      },
      port: 0,
    });
    serverUrl.value = server.url.toString();
    servers.push(server);
    const github = createGitHubApi({
      apiUrl: server.url.toString(),
      owner: "owner",
      repository: "repo",
      token: "secret",
    });
    expect(await github.listComments(42)).toEqual({
      _tag: "ok",
      value: [
        { body: "first", id: 1 },
        { body: "second", id: 2 },
      ],
    });
  });

  test("classifies HTTP errors without exposing the token", async () => {
    const server = Bun.serve({
      fetch: () => Response.json({ message: "rate limited" }, { status: 403 }),
      port: 0,
    });
    servers.push(server);
    const result = await createGitHubApi({
      apiUrl: server.url.toString(),
      owner: "owner",
      repository: "repo",
      token: "do-not-print",
    }).listDeployments("pr-2");
    expect(result._tag).toBe("err");
    if (result._tag === "err") {
      expect(result.error.status).toBe(403);
      expect(result.error.message).toContain("rate limited");
      expect(result.error.message).not.toContain("do-not-print");
    }
  });

  test("rejects non-positive response IDs", async () => {
    const server = Bun.serve({
      fetch: () => Response.json([{ id: 0 }]),
      port: 0,
    });
    servers.push(server);
    const result = await createGitHubApi({
      apiUrl: server.url.toString(),
      owner: "owner",
      repository: "repo",
      token: "secret",
    }).listDeployments("pr-2");
    expect(result._tag).toBe("err");
    if (result._tag === "err") {
      expect(result.error.message).toContain("expected shape");
    }
  });

  test("rejects unsafe integer response IDs", async () => {
    const server = Bun.serve({
      fetch: () => Response.json([{ id: Number.MAX_SAFE_INTEGER + 1 }]),
      port: 0,
    });
    servers.push(server);
    const result = await createGitHubApi({
      apiUrl: server.url.toString(),
      owner: "owner",
      repository: "repo",
      token: "secret",
    }).listDeployments("pr-2");
    expect(result._tag).toBe("err");
    if (result._tag === "err") {
      expect(result.error.message).toContain("expected shape");
    }
  });

  test("classifies invalid JSON returned when creating a deployment", async () => {
    const server = Bun.serve({
      fetch: () => new Response("not-json", { status: 201 }),
      port: 0,
    });
    servers.push(server);
    const result = await createGitHubApi({
      apiUrl: server.url.toString(),
      owner: "owner",
      repository: "repo",
      token: "secret",
    }).createDeployment({ environment: "prod", production: true, ref: "a".repeat(40) });
    expect(result._tag).toBe("err");
    if (result._tag === "err") {
      expect(result.error.operation).toBe("create deployment");
      expect(result.error.message).toContain("invalid JSON");
    }
  });

  test("refuses cross-origin pagination links", async () => {
    const server = Bun.serve({
      fetch: () =>
        Response.json([{ body: "first", id: 1 }], {
          headers: {
            Link: '<https://attacker.example/comments?page=2>; rel="next"',
          },
        }),
      port: 0,
    });
    servers.push(server);
    const result = await createGitHubApi({
      apiUrl: server.url.toString(),
      owner: "owner",
      repository: "repo",
      token: "secret",
    }).listComments(42);
    expect(result._tag).toBe("err");
    if (result._tag === "err") {
      expect(result.error.message).toContain("refusing cross-origin next link");
      expect(result.error.message).toContain("https://attacker.example");
    }
  });
});
