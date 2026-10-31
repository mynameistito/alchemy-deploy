/* eslint-disable sonarjs/no-wildcard-import, eslint/no-await-in-loop, eslint/require-await, promise/avoid-new, anti-slop/require-safety-comment-for-type-assertion -- Sequential negative cases exercise the public fetch transport. */
import { expect, test } from "bun:test";

import { State } from "alchemy/State";
import { Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { preprovisionedState } from "@/preprovisioned-state.ts";

const env = {
  ALCHEMY_PREVIEW_STATE_EXPECTED_ORIGIN: "https://state.example",
  ALCHEMY_PREVIEW_STATE_TOKEN: "synthetic-secret",
  ALCHEMY_PREVIEW_STATE_URL: "https://state.example",
};

const run = (
  environment: typeof env,
  handler: (...args: Parameters<typeof fetch>) => Promise<Response>
) => {
  const program = Effect.gen(function* program() {
    const getState = yield* State;
    const state = yield* getState;

    return yield* state.listStacks();
  });

  return Effect.runPromise(
    program.pipe(
      Effect.provide(
        preprovisionedState(environment).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      ),
      Effect.provideService(FetchHttpClient.Fetch, handler as typeof fetch)
    )
  );
};

test("public state client checks version then authenticated metadata with redirects disabled", async () => {
  const requests: string[] = [];

  const handler = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ) => {
    const url = String(input);
    requests.push(new URL(url).pathname);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer synthetic-secret"
    );

    return Promise.resolve(
      Response.json(url.endsWith("/version") ? { version: 7 } : ["docs"])
    );
  };

  expect(await run(env, handler)).toEqual(["docs"]);
  expect(requests).toEqual(["/version", "/state/stacks", "/state/stacks"]);
});

test("rejects bad settings, versions, auth and redirects without leaking secrets", async () => {
  for (const bad of [
    { ...env, ALCHEMY_PREVIEW_STATE_URL: "http://state.example" },
    { ...env, ALCHEMY_PREVIEW_STATE_URL: "https://state.example/path" },
    { ...env, ALCHEMY_PREVIEW_STATE_URL: "https://state.example/?x=1" },
    { ...env, ALCHEMY_PREVIEW_STATE_URL: "https://user@state.example" },
    { ...env, ALCHEMY_PREVIEW_STATE_URL: "" },
    { ...env, ALCHEMY_PREVIEW_STATE_EXPECTED_ORIGIN: "https://other.example" },
    { ...env, ALCHEMY_PREVIEW_STATE_TOKEN: "" },
  ]) {
    await expect(
      run(bad, async () => {
        throw new Error("unexpected request");
      })
    ).rejects.toThrow();
  }

  for (const response of [
    Response.json({ version: 6 }),
    new Response(null, {
      headers: { location: "https://other.example" },
      status: 302,
    }),
    new Response(null, { status: 401 }),
  ]) {
    const calls: string[] = [];

    const attempt = run(env, (input) => {
      calls.push(String(input));

      return Promise.resolve(response.clone());
    });

    await expect(attempt).rejects.toThrow(
      "Preprovisioned state backend unavailable or incompatible"
    );
    expect(calls).toHaveLength(1);
  }

  const calls: string[] = [];

  const rejected = run(env, (input) => {
    calls.push(String(input));

    return Promise.resolve(
      calls.length === 1
        ? Response.json({ version: 7 })
        : new Response(null, { status: 401 })
    );
  });

  await expect(rejected).rejects.toThrow(
    "Preprovisioned state backend unavailable or incompatible"
  );
  expect(calls.map((url) => new URL(url).pathname)).toEqual([
    "/version",
    "/state/stacks",
  ]);
});

test("a stalled backend times out with a generic error", async () => {
  const attempt = run(env, () => new Promise<Response>(() => {}));
  await expect(attempt).rejects.toThrow(
    "Preprovisioned state backend unavailable or incompatible"
  );
}, 15_000);

test("native references use actual stage and cache validated HTTP attributes", async () => {
  const account = "a".repeat(32);

  const environment = {
    ...env,
    ALCHEMY_WORKER_STATE_BINDINGS: JSON.stringify({
      CACHE: { id: "kv", stack: "isolated", stage: "pr-1", type: "kv" },
    }),
    CLOUDFLARE_ACCOUNT_ID: account,
    REPOSITORY_ID: "123",
    WORKER_NAME: "app",
  };

  const requests: string[] = [];

  const record = {
    attr: {
      accountId: account,
      extra: { mutable: true },
      namespaceId: "b".repeat(32),
    },
    fqn: "kv",
    logicalId: "kv",
    resourceType: "Cloudflare.KV.Namespace",
    status: "created",
  };

  const handler = async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);

    if (path === "/version") {
      return Response.json({ version: 7 });
    }

    if (path === "/state/stacks") {
      return Response.json(["isolated"]);
    }

    if (path === "/state/stacks/isolated/stages/pr-1/resources/kv") {
      return Response.json(record);
    }

    return new Response(null, { status: 404 });
  };

  const program = Effect.gen(function* program() {
    const getState = yield* State;
    const state = yield* getState;
    record.attr.namespaceId = "c".repeat(32);

    return yield* state.get({ fqn: "kv", stack: "isolated", stage: "pr-1" });
  });

  const execute = (stage: string, settings = environment) =>
    Effect.runPromise(
      program.pipe(
        Effect.provide(
          preprovisionedState(settings, stage).pipe(
            Layer.provide(FetchHttpClient.layer)
          )
        ),
        Effect.provideService(FetchHttpClient.Fetch, handler as typeof fetch)
      )
    );

  const result = await execute("pr-1");
  expect(result && "attr" in result && result.attr).toEqual({
    accountId: account,
    namespaceId: "b".repeat(32),
  });
  expect(requests).toEqual([
    "/version",
    "/state/stacks",
    "/state/stacks/isolated/stages/pr-1/resources/kv",
  ]);
  await expect(execute("pr-2")).rejects.toThrow();
  const before = requests.length;
  await expect(
    execute("pr-1", { ...environment, ALCHEMY_PREVIEW_STATE_TOKEN: "" })
  ).rejects.toThrow();
  expect(requests).toHaveLength(before);
});
