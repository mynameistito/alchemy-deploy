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
