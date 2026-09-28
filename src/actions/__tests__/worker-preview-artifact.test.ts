import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveWorkerPreviewEntrypoint } from "@/worker-preview-artifact.ts";

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
