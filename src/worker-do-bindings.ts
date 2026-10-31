/* oxlint-disable sonarjs/expression-complexity -- Input validation combines independent constraints. */
import { DurableObject } from "@alchemy.run/cloudflare/Workers";
import { z } from "zod";

import { err, ok } from "@/shared/result.ts";
import {
  isPreviewBindingName,
  parsePreviewEnvironment,
  parsePreviewJson,
} from "@/worker-preview-environment.ts";

/** Parse trusted local SQLite classes, rejecting all overlapping binding names. */
export const parseDurableObjectBindings = (
  env: Record<string, string | undefined>,
  stage: string
) => {
  try {
    const values = z
      .record(
        z.string(),
        z
          .object({
            className: z
              .string()
              .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u)
              .max(128),
          })
          .strict()
      )
      .parse(parsePreviewJson(env.ALCHEMY_WORKER_DO_BINDINGS ?? ""));

    const publicValues = parsePreviewEnvironment(
      env.ALCHEMY_WORKER_CONFIG ?? "",
      env.ALCHEMY_WORKER_SECRETS ?? ""
    );

    const state = z
      .record(z.string(), z.unknown())
      .parse(parsePreviewJson(env.ALCHEMY_WORKER_STATE_BINDINGS ?? ""));

    const limits = z
      .record(z.string(), z.unknown())
      .parse(parsePreviewJson(env.ALCHEMY_WORKER_RATE_LIMIT_BINDINGS ?? ""));

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
          Object.hasOwn(state, name) ||
          Object.hasOwn(limits, name)
      )
    ) {
      return err(new Error("Invalid Preview Durable Object bindings"));
    }

    return ok(
      Object.fromEntries(
        Object.entries(values).map(([name, value]) => [
          name,
          DurableObject(name, {
            className: value.className,
            storage: "sqlite",
          }),
        ])
      )
    );
  } catch {
    return err(new Error("Invalid Preview Durable Object bindings"));
  }
};
