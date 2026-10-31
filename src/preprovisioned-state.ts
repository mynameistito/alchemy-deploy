/* eslint-disable sonarjs/no-wildcard-import, sonarjs/expression-complexity, anti-slop/no-reflect-get, anti-slop/no-runtime-typeof, sonarjs/no-nested-functions -- The proxy wraps every method of the public State service in the same transport policy. */
import { makeHttpStateStore, State, StateStoreError } from "alchemy/State";
import { Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import {
  nativeReferenceState,
  parseNativeReferencePolicy,
} from "@/worker-state-bindings.ts";

// Pinned to @alchemy.run/cloudflare 2.0.0-beta.84 StateStore/Api.ts.
const CLOUDFLARE_STATE_VERSION = 7;

const failure = () =>
  new StateStoreError({
    message: "Preprovisioned state backend unavailable or incompatible",
  });

export const stateSettings = (env: Record<string, string | undefined>) => {
  if (
    !env.ALCHEMY_PREVIEW_STATE_URL?.trim() ||
    !env.ALCHEMY_PREVIEW_STATE_EXPECTED_ORIGIN?.trim() ||
    !env.ALCHEMY_PREVIEW_STATE_TOKEN?.trim()
  ) {
    throw failure();
  }

  try {
    const url = new URL(env.ALCHEMY_PREVIEW_STATE_URL ?? "");
    const origin = new URL(env.ALCHEMY_PREVIEW_STATE_EXPECTED_ORIGIN ?? "");

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      origin.origin !== url.origin ||
      origin.href !== `${origin.origin}/`
    ) {
      throw failure();
    }

    return { authToken: env.ALCHEMY_PREVIEW_STATE_TOKEN, url: url.origin };
  } catch {
    throw failure();
  }
};

export const preprovisionedState = (
  env: Record<string, string | undefined>,
  stage?: string
) =>
  Layer.effect(
    State,
    Effect.gen(function* stateLayer() {
      const context =
        yield* Effect.context<
          Effect.Services<ReturnType<typeof makeHttpStateStore>>
        >();

      const init = Effect.gen(function* init() {
        const settings = yield* Effect.try({
          catch: failure,
          try: () => stateSettings(env),
        });

        const raw = yield* makeHttpStateStore({
          ...settings,
          id: "preview-preprovisioned",
        });

        const guarded = new Proxy(raw, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);

            if (typeof value !== "function") {
              return value;
            }

            return (...args: unknown[]) =>
              value.apply(target, args).pipe(
                Effect.provideService(FetchHttpClient.RequestInit, {
                  redirect: "error",
                }),
                Effect.timeout("10 seconds"),
                Effect.mapError(failure)
              );
          },
        });

        if ((yield* guarded.getVersion()) !== CLOUDFLARE_STATE_VERSION) {
          return yield* failure();
        }

        yield* guarded.listStacks();

        const policy = parseNativeReferencePolicy(env, stage ?? "");

        if (policy._tag === "err") {
          return yield* policy.error;
        }

        return policy.value
          ? yield* nativeReferenceState(guarded, policy.value)
          : guarded;
      }).pipe(Effect.provideContext(context), Effect.orDie);

      return yield* Effect.cached(init);
    })
  );

export const verifyPreprovisionedState = async (
  env: Record<string, string | undefined>
) => {
  const check = Effect.gen(function* check() {
    const getState = yield* State;
    yield* getState;
  });

  await Effect.runPromise(
    check.pipe(
      Effect.provide(
        preprovisionedState(env).pipe(Layer.provide(FetchHttpClient.layer))
      )
    )
  );
};
