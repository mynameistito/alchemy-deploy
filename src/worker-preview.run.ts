import path from "node:path";

import { Stack } from "alchemy";
import {
  parseWorkerPreviewAssetsConfig,
  resolveWorkerPreviewAssetsDirectory,
  resolveWorkerPreviewEntrypoint,
} from "alchemy-deploy/worker-preview-artifact";
import {
  providers as cloudflareProviders,
  state as cloudflareState,
} from "alchemy/Cloudflare";
import { Worker } from "alchemy/Cloudflare/Workers";
import type { AssetsProps } from "alchemy/Cloudflare/Workers";
import { gen as effectGen, promise as effectPromise } from "effect/Effect";
import { z } from "zod";

type JsonValue =
  | boolean
  | JsonValue[]
  | { readonly [key: string]: JsonValue }
  | null
  | number
  | string;

interface WorkerCompatibility {
  date?: string;
  flags?: string[];
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.number(),
    z.string(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);
const workerEnvironmentSchema: z.ZodType<Record<string, JsonValue>> = z.record(
  z.string(),
  jsonValueSchema
);
const required = (name: string): string => {
  const value = Bun.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const artifactEntrypoint = (): Promise<string> => {
  if (Bun.env.PHASE === "cleanup") {
    return Promise.resolve(
      path.resolve(import.meta.dir, "worker-preview-placeholder.js")
    );
  }

  return resolveWorkerPreviewEntrypoint(
    required("ALCHEMY_PREVIEW_ARTIFACT"),
    required("ALCHEMY_PREVIEW_ENTRYPOINT")
  );
};

const artifactAssets = async (): Promise<AssetsProps | undefined> => {
  if (Bun.env.PHASE === "cleanup") {
    return;
  }
  const relativeDirectory = Bun.env.ALCHEMY_PREVIEW_ASSETS_DIRECTORY?.trim();
  if (!relativeDirectory) {
    return;
  }
  const input = Bun.env.ALCHEMY_PREVIEW_ASSETS_CONFIG?.trim() || "{}";
  return {
    directory: await resolveWorkerPreviewAssetsDirectory(
      required("ALCHEMY_PREVIEW_ARTIFACT"),
      relativeDirectory
    ),
    ...parseWorkerPreviewAssetsConfig(input),
  };
};

const parseWorkerEnvironment = (): Record<string, JsonValue> => {
  const input = Bun.env.ALCHEMY_WORKER_CONFIG?.trim();
  if (!input) {
    return {};
  }
  const parsed: unknown = JSON.parse(input);
  const result = workerEnvironmentSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      "ALCHEMY_WORKER_CONFIG must be a JSON object of Worker bindings"
    );
  }
  return result.data;
};

const previewCompatibility = () => {
  const date = Bun.env.ALCHEMY_PREVIEW_COMPATIBILITY_DATE?.trim();
  const flagsInput =
    Bun.env.ALCHEMY_PREVIEW_COMPATIBILITY_FLAGS?.trim() || "[]";
  const flags: unknown = JSON.parse(flagsInput);
  const result = z.array(z.string()).safeParse(flags);
  if (!result.success) {
    throw new Error(
      "ALCHEMY_PREVIEW_COMPATIBILITY_FLAGS must be a JSON array of strings"
    );
  }
  const compatibility: WorkerCompatibility = {};
  if (date) {
    compatibility.date = date;
  }
  if (result.data.length > 0) {
    compatibility.flags = result.data;
  }
  return compatibility;
};

const deploymentAnnotation =
  Bun.env.PHASE === "cleanup"
    ? {}
    : {
        message: `PR #${Bun.env.PULL_REQUEST_NUMBER ?? "unknown"} (${required("DEPLOYMENT_SHA")})`,
        tag: required("DEPLOYMENT_SHA"),
      };

const workerPreviewStack = function* workerPreviewStack() {
  const preview = yield* Worker("WorkerPreview", {
    assets: yield* effectPromise(artifactAssets),
    bundle: false,
    compatibility: previewCompatibility(),
    env: parseWorkerEnvironment(),
    main: yield* effectPromise(artifactEntrypoint),
    preview: {
      name: required("STAGE"),
      of: required("WORKER_NAME"),
      ...deploymentAnnotation,
    },
  });
  return { url: preview.url };
};

export default Stack(
  `alchemy-deploy-${required("REPOSITORY_ID")}-${required("WORKER_NAME")}`,
  { providers: cloudflareProviders(), state: cloudflareState() },
  effectGen(workerPreviewStack)
);
