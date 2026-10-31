/* oxlint-disable eslint/no-plusplus, eslint/no-await-in-loop, unicorn/no-await-expression-member, sonarjs/no-wildcard-import, sonarjs/no-unenclosed-multiline-block, anti-slop/no-unsafe-dictionary-type, sonarjs/no-undefined-assignment, eslint/sort-keys, anti-slop/require-readable-spacing -- Test fixtures and sequential state checks exercise the provider boundary. */
/* oxlint-disable anti-slop/no-unknown-parameters -- Provider contracts are recorded without interpreting their shape. */
import { expect, test } from "bun:test";

import * as Output from "alchemy/Output";
import { InMemoryService, State } from "alchemy/State";
import { Effect } from "effect";

import {
  nativeReferenceBindings,
  nativeReferenceState,
  parseNativeReferencePolicy,
} from "@/worker-state-bindings.ts";

const account = "a".repeat(32);
const env = {
  ALCHEMY_WORKER_STATE_BINDINGS: JSON.stringify({
    KV: { id: "kv", stack: "isolated", stage: "pr-1", type: "kv" },
    DB: { id: "db", stack: "isolated", stage: "pr-1", type: "d1" },
    SECRET: { id: "secret", stack: "isolated", stage: "pr-1", type: "secret" },
  }),
  CLOUDFLARE_ACCOUNT_ID: account,
  REPOSITORY_ID: "123",
  WORKER_NAME: "app",
};
const parsed = () => {
  const result = parseNativeReferencePolicy(env, "pr-1");

  if (result._tag === "err" || !result.value) {
    throw new Error("invalid test policy");
  }
  return result.value;
};
const row = (id: string, type: string, attr: Record<string, unknown>) => ({
  attr,
  bindings: [],
  downstream: [],
  fqn: id,
  instanceId: "i",
  logicalId: id,
  namespace: undefined,
  props: {},
  providerVersion: 1,
  resourceType: type,
  status: "created" as const,
});

test("public references classify and resolve one immutable projected snapshot", async () => {
  const kv = row("kv", "Cloudflare.KV.Namespace", {
    accountId: account,
    extra: { mutable: true },
    namespaceId: "b".repeat(32),
  });
  const db = row("db", "Cloudflare.D1Database", {
    accountId: account,
    databaseId: "12345678-1234-1234-1234-123456789abc",
  });
  const secret = row("secret", "Cloudflare.SecretsStore.Secret", {
    accountId: account,
    secretName: "demo",
    storeId: "c".repeat(32),
  });
  const base = await Effect.runPromise(
    InMemoryService({ isolated: { "pr-1": { db, kv, secret } } })
  );
  let reads = 0;
  const guarded = await Effect.runPromise(
    nativeReferenceState(
      {
        ...base,
        get: (request) => {
          reads++;

          return base.get(request);
        },
      },
      parsed()
    )
  );
  const bindings: unknown[] = [];
  const providerPath = [
    "../../../node_modules/@alchemy.run/cloudflare/src/Workers",
    "WorkerAsyncBindings.ts",
  ].join("/");
  const provider: {
    bindWorkerAsyncBindings: (
      resource: unknown,
      props: unknown
    ) => Effect.Effect<void>;
  } = await import(providerPath);
  const resource = {
    Mode: "remote",
    bind: () => (data: unknown) =>
      Effect.sync(() => {
        bindings.push(data);
      }),
  };
  const refs = await Effect.runPromise(nativeReferenceBindings(parsed()));
  await Effect.runPromise(
    provider.bindWorkerAsyncBindings(resource, { env: refs })
  );
  const evaluate = () =>
    Effect.runPromise(
      Output.evaluate(bindings, {}).pipe(
        Effect.provideService(State, Effect.succeed(guarded))
      )
    );
  const first = await evaluate();
  kv.attr.namespaceId = "d".repeat(32);
  expect(await evaluate()).toEqual(first);
  expect(reads).toBe(3);
  const snapshot = await Effect.runPromise(
    guarded.get({ fqn: "kv", stack: "isolated", stage: "pr-1" })
  );
  expect(snapshot && "attr" in snapshot && snapshot.attr).toEqual({
    accountId: account,
    namespaceId: "b".repeat(32),
  });
  expect(JSON.stringify(first)).toContain('"type":"kv_namespace"');
  expect(JSON.stringify(first)).toContain('"type":"d1"');
  expect(JSON.stringify(first)).toContain('"type":"secrets_store_secret"');
});

test("parser rejects duplicate, overlap, reserved and wrong stage references", () => {
  for (const input of [
    '{"KV":{"id":"kv","stack":"isolated","stage":"pr-1","type":"kv"},"KV":{"id":"kv","stack":"isolated","stage":"pr-1","type":"kv"}}',
    '{"ALCHEMY_STAGE":{"id":"kv","stack":"isolated","stage":"pr-1","type":"kv"}}',
    env.ALCHEMY_WORKER_STATE_BINDINGS,
  ]) {
    const candidate = {
      ...env,
      ALCHEMY_WORKER_CONFIG:
        input === env.ALCHEMY_WORKER_STATE_BINDINGS ? '{"KV":"x"}' : "",
      ALCHEMY_WORKER_STATE_BINDINGS: input,
    };
    expect(parseNativeReferencePolicy(candidate, "pr-1")._tag).toBe("err");
  }

  expect(parseNativeReferencePolicy(env, "pr-2")._tag).toBe("err");
});

test("invalid or missing rows fail during initialization", async () => {
  const db = row("db", "Cloudflare.D1Database", {
    accountId: account,
    databaseId: "12345678-1234-1234-1234-123456789abc",
  });
  const secret = row("secret", "Cloudflare.SecretsStore.Secret", {
    accountId: account,
    storeId: "c".repeat(32),
    secretName: "demo",
  });
  const good = row("kv", "Cloudflare.KV.Namespace", {
    accountId: account,
    namespaceId: "b".repeat(32),
  });
  const validBase = await Effect.runPromise(
    InMemoryService({ isolated: { "pr-1": { kv: good, db, secret } } })
  );
  expect(
    (
      await Effect.runPromise(
        Effect.exit(nativeReferenceState(validBase, parsed()))
      )
    )._tag
  ).toBe("Success");
  for (const invalid of [
    { ...good, fqn: "different" },
    { ...good, logicalId: "different" },
    row("kv", "wrong", { accountId: account, namespaceId: "b".repeat(32) }),
    row("kv", "Cloudflare.KV.Namespace", {
      accountId: "bad",
      namespaceId: "b".repeat(32),
    }),
    row("kv", "Cloudflare.KV.Namespace", { accountId: account }),
    {
      ...row("kv", "Cloudflare.KV.Namespace", {
        accountId: account,
        namespaceId: "b".repeat(32),
      }),
      status: "creating" as const,
    },
  ]) {
    const base = await Effect.runPromise(
      InMemoryService({ isolated: { "pr-1": { kv: invalid, db, secret } } })
    );
    const initialized = await Effect.runPromise(
      Effect.exit(nativeReferenceState(base, parsed()))
    );
    expect(initialized._tag).toBe("Failure");
  }
  const missingBase = await Effect.runPromise(
    InMemoryService({ isolated: { "pr-1": { db, secret } } })
  );
  expect(
    (
      await Effect.runPromise(
        Effect.exit(nativeReferenceState(missingBase, parsed()))
      )
    )._tag
  ).toBe("Failure");
});

test("guard denies unlisted reads and cross-stack writes", async () => {
  const refs = {
    kv: row("kv", "Cloudflare.KV.Namespace", {
      accountId: account,
      namespaceId: "b".repeat(32),
    }),
    db: row("db", "Cloudflare.D1Database", {
      accountId: account,
      databaseId: "12345678-1234-1234-1234-123456789abc",
    }),
    secret: row("secret", "Cloudflare.SecretsStore.Secret", {
      accountId: account,
      storeId: "c".repeat(32),
      secretName: "demo",
    }),
  };
  const base = await Effect.runPromise(
    InMemoryService({ isolated: { "pr-1": refs } })
  );
  const guarded = await Effect.runPromise(nativeReferenceState(base, parsed()));
  for (const operation of [
    guarded.get({ fqn: "unknown", stack: "isolated", stage: "pr-1" }),
    guarded.delete({ fqn: "kv", stack: "isolated", stage: "pr-1" }),
    guarded.set({
      fqn: "kv",
      stack: "isolated",
      stage: "pr-1",
      value: refs.kv,
    }),
    guarded.list({ stack: "isolated", stage: "pr-1" }),
  ]) {
    expect((await Effect.runPromise(Effect.exit(operation)))._tag).toBe(
      "Failure"
    );
  }
});
