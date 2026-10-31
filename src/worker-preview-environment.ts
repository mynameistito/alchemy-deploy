import { make as redact } from "effect/Redacted";
import { parseDocument } from "yaml";
import { z } from "zod";

import { err, ok } from "@/shared/result.ts";

type JsonValue =
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue }
  | null
  | number
  | string;

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.number(),
    z.string(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ])
);

const publicSchema = z.record(z.string(), jsonValue);
const secretSchema = z.record(z.string(), z.string());
const bindingName = /^[A-Za-z_]\w*$/u;

const reservedNames = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "ALCHEMY_PHASE",
  "ALCHEMY_WORKER_NAME",
  "ALCHEMY_STACK_NAME",
  "ALCHEMY_STAGE",
  "ALCHEMY_CLOUDFLARE_ACCOUNT_ID",
]);

const parse = (input: string) => {
  if (!input.trim()) {
    return {};
  }

  const value: unknown = JSON.parse(input);

  if (parseDocument(input, { uniqueKeys: true }).errors.length) {
    throw new Error("Duplicate or invalid JSON keys");
  }

  if (Object.keys(new Object(value)).some((key) => reservedNames.has(key))) {
    throw new Error("Reserved Preview binding name");
  }

  return value;
};

/** Parse public and secret Preview values without including input in errors. */
export const parsePreviewEnvironment = (
  publicInput: string,
  secretInput: string
) => {
  try {
    const publicValues = publicSchema.safeParse(parse(publicInput));
    const secrets = secretSchema.safeParse(parse(secretInput));

    if (
      !publicValues.success ||
      !secrets.success ||
      [...Object.keys(publicValues.data), ...Object.keys(secrets.data)].some(
        (key) => !bindingName.test(key) || reservedNames.has(key)
      ) ||
      Object.keys(secrets.data).some((key) =>
        Object.hasOwn(publicValues.data, key)
      )
    ) {
      return err(
        new Error(
          "Worker Preview inputs must be JSON objects with valid, unique, non-overlapping keys; secret values must be strings"
        )
      );
    }

    return ok({
      ...publicValues.data,
      ...Object.fromEntries(
        Object.entries(secrets.data).map(([key, value]) => [key, redact(value)])
      ),
    });
  } catch {
    return err(
      new Error(
        "Worker Preview inputs must be JSON objects with valid, unique, non-overlapping keys; secret values must be strings"
      )
    );
  }
};
