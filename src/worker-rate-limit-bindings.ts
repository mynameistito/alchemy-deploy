/* oxlint-disable sonarjs/expression-complexity, anti-slop/require-readable-spacing -- The input boundary checks independent constraints together. */
import { RateLimit } from "@alchemy.run/cloudflare/Workers";
import { z } from "zod";

import { err, ok } from "@/shared/result.ts";
import {
  isPreviewBindingName,
  parsePreviewEnvironment,
  parsePreviewJson,
} from "@/worker-preview-environment.ts";

const item = z
  .object({
    limit: z.number().int().positive().safe(),
    namespaceId: z
      .string()
      .regex(/^[1-9]\d*$/u)
      .max(128),
    period: z.union([z.literal(10), z.literal(60)]),
  })
  .strict();

/** Parse trusted Preview rate-limit configuration without exposing input in errors. */
export const parseRateLimitBindings = (
  env: Record<string, string | undefined>,
  stage: string
) => {
  try {
    const values = z
      .record(z.string(), item)
      .parse(parsePreviewJson(env.ALCHEMY_WORKER_RATE_LIMIT_BINDINGS ?? ""));
    const publicValues = parsePreviewEnvironment(
      env.ALCHEMY_WORKER_CONFIG ?? "",
      env.ALCHEMY_WORKER_SECRETS ?? ""
    );
    const stateValues = z
      .record(z.string(), z.unknown())
      .parse(parsePreviewJson(env.ALCHEMY_WORKER_STATE_BINDINGS ?? ""));

    if (
      publicValues._tag === "err" ||
      Object.keys(values).length > 32 ||
      (Object.keys(values).length > 0 &&
        (!/^pr-[1-9]\d*$/u.test(stage) ||
          !Number.isSafeInteger(Number(stage.slice(3))))) ||
      Object.keys(values).some(
        (name) =>
          !isPreviewBindingName(name) ||
          Object.hasOwn(publicValues.value, name) ||
          Object.hasOwn(stateValues, name)
      )
    ) {
      return err(new Error("Invalid Preview rate-limit bindings"));
    }

    return ok(
      Object.fromEntries(
        Object.entries(values).map(([name, value]) => [
          name,
          RateLimit(name, {
            namespaceId: value.namespaceId,
            simple: { limit: value.limit, period: value.period },
          }),
        ])
      )
    );
  } catch {
    return err(new Error("Invalid Preview rate-limit bindings"));
  }
};
