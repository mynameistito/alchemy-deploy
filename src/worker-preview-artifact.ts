import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { AssetsConfig } from "alchemy/Cloudflare/Workers";
import { z } from "zod";

const previewAssetsConfigSchema = z
  .object({
    headers: z.string().optional(),
    htmlHandling: z
      .enum([
        "auto-trailing-slash",
        "force-trailing-slash",
        "drop-trailing-slash",
        "none",
      ])
      .optional(),
    notFoundHandling: z
      .enum(["none", "404-page", "single-page-application"])
      .optional(),
    redirects: z.string().optional(),
    runWorkerFirst: z.union([z.boolean(), z.array(z.string())]).optional(),
    serveDirectly: z.boolean().optional(),
  })
  .strict()
  .transform((input): AssetsConfig => {
    const config: AssetsConfig = {};
    if (input.headers !== undefined) {
      config.headers = input.headers;
    }
    if (input.htmlHandling !== undefined) {
      config.htmlHandling = input.htmlHandling;
    }
    if (input.notFoundHandling !== undefined) {
      config.notFoundHandling = input.notFoundHandling;
    }
    if (input.redirects !== undefined) {
      config.redirects = input.redirects;
    }
    if (input.runWorkerFirst !== undefined) {
      config.runWorkerFirst = input.runWorkerFirst;
    }
    if (input.serveDirectly !== undefined) {
      config.serveDirectly = input.serveDirectly;
    }
    return config;
  });

/** Parse the restricted routing configuration supported for artifact assets. */
export const parseWorkerPreviewAssetsConfig = (input: string): AssetsConfig => {
  const parsed: unknown = JSON.parse(input);
  const result = previewAssetsConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      "ALCHEMY_PREVIEW_ASSETS_CONFIG must be a valid Worker assets configuration object"
    );
  }
  return result.data;
};

/** Resolve a prebuilt entrypoint while rejecting paths outside its artifact. */
export const resolveWorkerPreviewEntrypoint = async (
  artifactDirectory: string,
  relativeEntrypoint: string
): Promise<string> => {
  const artifactRoot = await realpath(artifactDirectory);
  if (
    path.isAbsolute(relativeEntrypoint) ||
    relativeEntrypoint.split(/[\\/]/u).some((part) => part === "..")
  ) {
    throw new Error("ALCHEMY_PREVIEW_ENTRYPOINT must stay inside the artifact");
  }

  const entrypoint = await realpath(
    path.resolve(artifactRoot, relativeEntrypoint)
  );
  const relativePath = path.relative(artifactRoot, entrypoint);
  const entrypointStat = await stat(entrypoint);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath) ||
    !entrypointStat.isFile()
  ) {
    throw new Error(
      "Worker artifact entrypoint must be a regular file in the artifact"
    );
  }
  return entrypoint;
};

/** Resolve an optional static asset directory without following paths outside its artifact. */
export const resolveWorkerPreviewAssetsDirectory = async (
  artifactDirectory: string,
  relativeDirectory: string
): Promise<string> => {
  const artifactRoot = await realpath(artifactDirectory);
  if (
    path.isAbsolute(relativeDirectory) ||
    relativeDirectory.split(/[\\/]/u).some((part) => part === "..")
  ) {
    throw new Error(
      "ALCHEMY_PREVIEW_ASSETS_DIRECTORY must stay inside the artifact"
    );
  }

  const assetsDirectory = await realpath(
    path.resolve(artifactRoot, relativeDirectory)
  );
  const relativePath = path.relative(artifactRoot, assetsDirectory);
  const assetsStat = await stat(assetsDirectory);
  const isOutsideArtifact =
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);
  if (relativePath === "" || isOutsideArtifact || !assetsStat.isDirectory()) {
    throw new Error(
      "Worker Preview assets directory must be a directory inside the artifact"
    );
  }
  return assetsDirectory;
};
