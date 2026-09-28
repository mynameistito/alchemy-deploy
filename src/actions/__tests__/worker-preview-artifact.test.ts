import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseWorkerPreviewAssetsConfig,
  resolveWorkerPreviewAssetsDirectory,
  resolveWorkerPreviewEntrypoint,
} from "@/worker-preview-artifact.ts";

describe("Worker Preview artifact entrypoint", () => {
  test("accepts a regular file inside the artifact", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alchemy-preview-"));
    const entrypoint = path.join(directory, "dist", "index.mjs");
    await mkdir(path.dirname(entrypoint));
    await writeFile(entrypoint, "export default {};");

    try {
      expect(
        await resolveWorkerPreviewEntrypoint(directory, "dist/index.mjs")
      ).toBe(entrypoint);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test.each(["../outside.mjs", "dist/../../outside.mjs"])(
    "rejects traversal path %s",
    async (entrypoint) => {
      const directory = await mkdtemp(path.join(tmpdir(), "alchemy-preview-"));
      try {
        await expect(
          resolveWorkerPreviewEntrypoint(directory, entrypoint)
        ).rejects.toThrow("must stay inside the artifact");
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }
  );

  test("rejects directories and missing files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alchemy-preview-"));
    await mkdir(path.join(directory, "folder"));
    try {
      await expect(
        resolveWorkerPreviewEntrypoint(directory, "folder")
      ).rejects.toThrow("regular file");
      await expect(
        resolveWorkerPreviewEntrypoint(directory, "missing.mjs")
      ).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("Worker Preview artifact assets", () => {
  test("parses supported routing settings without accepting unknown fields", () => {
    expect(
      parseWorkerPreviewAssetsConfig(
        JSON.stringify({
          htmlHandling: "force-trailing-slash",
          notFoundHandling: "single-page-application",
          runWorkerFirst: ["/api/*"],
        })
      )
    ).toStrictEqual({
      htmlHandling: "force-trailing-slash",
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    });
    expect(() =>
      parseWorkerPreviewAssetsConfig('{"directory":"../outside"}')
    ).toThrow("valid Worker assets configuration");
    expect(() =>
      parseWorkerPreviewAssetsConfig('{"runWorkerFirst":"/api/*"}')
    ).toThrow("valid Worker assets configuration");
  });

  test("accepts a directory inside the artifact", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alchemy-preview-"));
    const assets = path.join(directory, "dist", "assets");
    await mkdir(assets, { recursive: true });

    try {
      expect(
        await resolveWorkerPreviewAssetsDirectory(directory, "dist/assets")
      ).toBe(assets);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test.each(["../outside", "dist/../../outside"])(
    "rejects traversal path %s",
    async (assetsDirectory) => {
      const directory = await mkdtemp(path.join(tmpdir(), "alchemy-preview-"));
      try {
        await expect(
          resolveWorkerPreviewAssetsDirectory(directory, assetsDirectory)
        ).rejects.toThrow("must stay inside the artifact");
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }
  );

  test.each([".", "./"])(
    "rejects the artifact root as the assets directory (%s)",
    async (assetsDirectory) => {
      const directory = await mkdtemp(path.join(tmpdir(), "alchemy-preview-"));
      try {
        await expect(
          resolveWorkerPreviewAssetsDirectory(directory, assetsDirectory)
        ).rejects.toThrow("must be a directory inside the artifact");
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }
  );

  test("rejects files and missing directories", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alchemy-preview-"));
    await writeFile(path.join(directory, "file.txt"), "asset");
    try {
      await expect(
        resolveWorkerPreviewAssetsDirectory(directory, "file.txt")
      ).rejects.toThrow("must be a directory");
      await expect(
        resolveWorkerPreviewAssetsDirectory(directory, "missing")
      ).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects a symlink that resolves outside the artifact", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alchemy-preview-"));
    const outside = await mkdtemp(path.join(tmpdir(), "alchemy-assets-"));
    const link = path.join(directory, "assets");
    await symlink(outside, link, "junction");

    try {
      await expect(
        resolveWorkerPreviewAssetsDirectory(directory, "assets")
      ).rejects.toThrow("must be a directory inside the artifact");
    } finally {
      await rm(directory, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });
});
