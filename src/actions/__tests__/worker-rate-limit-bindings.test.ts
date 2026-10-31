/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-readable-spacing -- Record provider boundary values. */
import { expect, test } from "bun:test";

import { Effect } from "effect";

import { parseRateLimitBindings } from "@/worker-rate-limit-bindings.ts";

test("rejects invalid and overlapping rate limits without echoing input", () => {
  for (const input of [
    '{"A":{"namespaceId":"0","limit":1,"period":10}}',
    '{"A":{"namespaceId":"1","limit":0,"period":10}}',
    '{"A":{"namespaceId":"1","limit":9007199254740992,"period":10}}',
    '{"A":{"namespaceId":"1","limit":1,"period":30}}',
    '{"A":{"namespaceId":"1","limit":1,"period":10,"extra":"sentinel"}}',
    '{"A":{"namespaceId":"1","limit":1,"period":10},"A":{}}',
    '{"__proto__":{}}',
    "sentinel",
  ]) {
    const result = parseRateLimitBindings(
      { ALCHEMY_WORKER_RATE_LIMIT_BINDINGS: input },
      "pr-1"
    );
    expect(result._tag).toBe("err");
    expect(JSON.stringify(result)).not.toContain("sentinel");
  }

  const binding = '{"A":{"namespaceId":"1","limit":1,"period":10}}';

  for (const key of [
    "ALCHEMY_WORKER_CONFIG",
    "ALCHEMY_WORKER_SECRETS",
    "ALCHEMY_WORKER_STATE_BINDINGS",
  ]) {
    expect(
      parseRateLimitBindings(
        { ALCHEMY_WORKER_RATE_LIMIT_BINDINGS: binding, [key]: '{"A":"x"}' },
        "pr-1"
      )._tag
    ).toBe("err");
  }

  expect(
    parseRateLimitBindings(
      { ALCHEMY_WORKER_RATE_LIMIT_BINDINGS: binding },
      "prod"
    )._tag
  ).toBe("err");
  expect(parseRateLimitBindings({}, "pr-1")).toEqual({ _tag: "ok", value: {} });
});

test("pinned provider classifies the native rate limit without a resource", async () => {
  const result = parseRateLimitBindings(
    {
      ALCHEMY_WORKER_RATE_LIMIT_BINDINGS:
        '{"THROTTLE":{"namespaceId":"12345678901234567890","limit":5,"period":60}}',
    },
    "pr-1"
  );

  if (result._tag === "err") {
    throw result.error;
  }
  const providerPath =
    "../../../node_modules/@alchemy.run/cloudflare/src/Workers/WorkerAsyncBindings.ts";
  const provider: {
    bindWorkerAsyncBindings: (
      resource: unknown,
      props: unknown
    ) => Effect.Effect<void>;
  } = await import(providerPath);
  const bindings: unknown[] = [];
  await Effect.runPromise(
    provider.bindWorkerAsyncBindings(
      {
        Mode: "remote",
        bind: () => (data: unknown) =>
          Effect.sync(() => {
            bindings.push(data);
          }),
      },
      { env: result.value }
    )
  );
  expect(bindings).toHaveLength(1);
  expect(bindings).toContainEqual(
    expect.objectContaining({
      bindings: [
        {
          name: "THROTTLE",
          namespaceId: "12345678901234567890",
          simple: { limit: 5, period: 60 },
          type: "ratelimit",
        },
      ],
    })
  );
});
