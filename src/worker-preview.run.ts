import path from "node:path";

import {
  providers as cloudflareProviders,
  state as cloudflareState,
} from "@alchemy.run/cloudflare";
import { Worker } from "@alchemy.run/cloudflare/Workers";
import type { AssetsProps } from "@alchemy.run/cloudflare/Workers";
import { Stack } from "alchemy";
import {
  parseWorkerPreviewAssetsConfig,
  resolveWorkerPreviewAssetsDirectory,
  resolveWorkerPreviewEntrypoint,
} from "alchemy-deploy/worker-preview-artifact";
import { parsePreviewEnvironment } from "alchemy-deploy/worker-preview-environment";
import { gen as effectGen, promise as effectPromise } from "effect/Effect";
import { z } from "zod";

interface WorkerCompatibility {
  date?: string;
  flags?: string[];
}

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
    return undefined;
  }

  const relativeDirectory = Bun.env.ALCHEMY_PREVIEW_ASSETS_DIRECTORY?.trim();

  if (!relativeDirectory) {
    return undefined;
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

const previewEnvironment = () => {
  const result = parsePreviewEnvironment(
    Bun.env.ALCHEMY_WORKER_CONFIG ?? "",
    Bun.env.ALCHEMY_WORKER_SECRETS ?? ""
  );

  if (result._tag === "err") {
    throw result.error;
  }

  return result.value;
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
    env: previewEnvironment(),
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
