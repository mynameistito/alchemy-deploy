/* oxlint-disable eslint/complexity, eslint/no-control-regex, sonarjs/expression-complexity, unicorn/consistent-function-scoping, unicorn/no-hex-escape, anti-slop/require-readable-spacing -- Boundary validation and the state policy keep related checks together. */
import { D1, KV, SecretsStore } from "@alchemy.run/cloudflare";
import { StateStoreError } from "alchemy/State";
import type { PersistedState, StateService } from "alchemy/State";
import { Effect } from "effect";
import { z } from "zod";

import { err, ok } from "@/shared/result.ts";
import {
  isPreviewBindingName,
  parsePreviewEnvironment,
  parsePreviewJson,
} from "@/worker-preview-environment.ts";

const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const accountId = /^[a-f0-9]{32}$/u;
const namespaceId = /^[a-f0-9]{32}$/u;
const databaseId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

const reference = z
  .object({
    id: z.string().regex(identifier),
    stack: z.string().regex(identifier),
    stage: z.string(),
    type: z.enum(["kv", "d1", "secret"]),
  })
  .strict();

type Reference = z.infer<typeof reference>;

export interface NativeReferencePolicy {
  readonly account: string;
  readonly ownStack: string;
  readonly stage: string;
  readonly references: Readonly<Record<string, Reference>>;
}

const invalid = () =>
  new StateStoreError({
    message: "Native Preview resource reference unavailable or invalid",
  });

const keyFor = (target: { stack: string; stage: string; fqn: string }) =>
  JSON.stringify([target.stack, target.stage, target.fqn]);

/** Only trusted action configuration may supply reference policies. */
export const parseNativeReferencePolicy = (
  env: Record<string, string | undefined>,
  stage: string
) => {
  const input = env.ALCHEMY_WORKER_STATE_BINDINGS ?? "";

  if (!input.trim()) {
    return ok(undefined);
  }
  try {
    const values = z
      .record(z.string(), reference)
      .parse(parsePreviewJson(input));

    const publicEnvironment = parsePreviewEnvironment(
      env.ALCHEMY_WORKER_CONFIG ?? "",
      env.ALCHEMY_WORKER_SECRETS ?? ""
    );

    const account = env.CLOUDFLARE_ACCOUNT_ID ?? "";
    const repository = env.REPOSITORY_ID ?? "";
    const worker = env.WORKER_NAME ?? "";
    const ownStack = `alchemy-deploy-${repository}-${worker}`;

    if (
      publicEnvironment._tag === "err" ||
      !/^pr-[1-9]\d*$/u.test(stage) ||
      !Number.isSafeInteger(Number(stage.slice(3))) ||
      !accountId.test(account) ||
      !/^[1-9]\d*$/u.test(repository) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(worker) ||
      worker.length > 63 ||
      Object.keys(values).length > 32
    ) {
      return err(invalid());
    }
    const targets = new Map<string, Reference["type"]>();

    for (const [name, target] of Object.entries(values)) {
      const key = keyFor({ ...target, fqn: target.id });

      if (
        !isPreviewBindingName(name) ||
        Object.hasOwn(publicEnvironment.value, name) ||
        target.stage !== stage ||
        target.stack === ownStack ||
        (targets.has(key) && targets.get(key) !== target.type)
      ) {
        return err(invalid());
      }
      targets.set(key, target.type);
    }

    for (const target of Object.values(values)) {
      Object.freeze(target);
    }
    return ok(
      Object.freeze({
        account,
        ownStack,
        references: Object.freeze(values),
        stage,
      }) satisfies NativeReferencePolicy
    );
  } catch {
    return err(invalid());
  }
};

/** Public resource references register no resource lifecycle operations. */
export const nativeReferenceBindings = (policy: NativeReferencePolicy) =>
  Effect.gen(function* references() {
    const result: Record<
      string,
      KV.Namespace | D1.Database | SecretsStore.Secret
    > = {};

    for (const [name, target] of Object.entries(policy.references)) {
      const options = { stack: target.stack, stage: target.stage };

      if (target.type === "kv") {
        result[name] = yield* KV.Namespace.ref(target.id, options);
      } else if (target.type === "d1") {
        result[name] = yield* D1.Database.ref(target.id, options);
      } else {
        result[name] = yield* SecretsStore.Secret.ref(target.id, options);
      }
    }

    return result;
  });

const attributes = {
  d1: z.object({
    accountId: z.string(),
    databaseId: z.string().regex(databaseId),
  }),
  kv: z.object({
    accountId: z.string(),
    namespaceId: z.string().regex(namespaceId),
  }),
  secret: z.object({
    accountId: z.string(),
    secretName: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\u0000-\u001F\x7F]+$/u)
      .refine((name) => name.trim() === name),
    storeId: z.string().regex(namespaceId),
  }),
};

const resourceTypes = {
  d1: "Cloudflare.D1Database",
  kv: "Cloudflare.KV.Namespace",
  secret: "Cloudflare.SecretsStore.Secret",
};

const rowIdentity = z.object({
  attr: z.record(z.string(), z.unknown()),
  fqn: z.string(),
  kind: z.literal("resource").optional(),
  logicalId: z.string(),
  providerMode: z.literal("live").optional(),
  resourceType: z.string(),
  status: z.enum(["created", "updated"]),
});

const copiedRow = (
  row: PersistedState | undefined,
  target: Reference,
  account: string
) =>
  Effect.try({
    catch: invalid,
    try: () => {
      const parsed = rowIdentity.parse(row);
      const attr = attributes[target.type].parse(parsed.attr);

      if (
        !row ||
        parsed.fqn !== target.id ||
        parsed.logicalId !== target.id ||
        parsed.resourceType !== resourceTypes[target.type] ||
        attr.accountId !== account
      ) {
        throw invalid();
      }

      const copy = structuredClone(row);

      if (!("attr" in copy)) {
        throw invalid();
      }
      copy.attr = Object.freeze(attr);

      return Object.freeze(copy);
    },
  });

/** Cache one validated immutable row per reference; prohibit cross-stack writes. */
export const nativeReferenceState = (
  base: StateService,
  policy: NativeReferencePolicy
) =>
  Effect.gen(function* guardedReferences() {
    const cached = new Map<
      string,
      Effect.Effect<PersistedState, StateStoreError>
    >();

    for (const target of Object.values(policy.references)) {
      const request = {
        fqn: target.id,
        stack: target.stack,
        stage: target.stage,
      };
      const key = keyFor(request);

      if (!cached.has(key)) {
        cached.set(
          key,
          yield* Effect.cached(
            base
              .get(request)
              .pipe(
                Effect.flatMap((row) => copiedRow(row, target, policy.account))
              )
          )
        );
      }
    }

    yield* Effect.all([...cached.values()]);

    const own = (request: { stack: string; stage?: string }) =>
      request.stack === policy.ownStack && request.stage === policy.stage;

    const deny = () => Effect.fail(invalid());

    const guarded: StateService = {
      ...base,
      delete: (request) => (own(request) ? base.delete(request) : deny()),
      deleteStack: (request) =>
        own(request) ? base.deleteStack(request) : deny(),
      get: (request) =>
        own(request)
          ? base.get(request)
          : (cached.get(keyFor(request)) ?? deny()),
      getOutput: (request) => (own(request) ? base.getOutput(request) : deny()),
      getReplacedResources: (request) =>
        own(request) ? base.getReplacedResources(request) : deny(),
      list: (request) => (own(request) ? base.list(request) : deny()),
      listStacks: () => Effect.succeed([policy.ownStack]),
      listStages: (stack) =>
        stack === policy.ownStack ? base.listStages(stack) : deny(),
      set: (request) => (own(request) ? base.set(request) : deny()),
      setOutput: (request) => (own(request) ? base.setOutput(request) : deny()),
    };

    return guarded;
  });
