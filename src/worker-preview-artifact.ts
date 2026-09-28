import { realpath, stat } from "node:fs/promises";
import path from "node:path";

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
