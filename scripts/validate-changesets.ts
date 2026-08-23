import { readdir } from "node:fs/promises";

import { parse } from "yaml";
import { z } from "zod";

const head = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], {
  stderr: "ignore",
  stdout: "ignore",
});
const localMain = Bun.spawnSync([
  "git",
  "show-ref",
  "--verify",
  "--quiet",
  "refs/heads/main",
]);
const remoteMain = Bun.spawnSync([
  "git",
  "show-ref",
  "--verify",
  "--quiet",
  "refs/remotes/origin/main",
]);
const resolveBaseRef = (): string | undefined => {
  if (localMain.exitCode === 0) {
    return "main";
  }
  return remoteMain.exitCode === 0 ? "origin/main" : undefined;
};
const baseRef = resolveBaseRef();
const VERSION = /"version"\s*:\s*"(?<version>\d+\.\d+\.\d+)"/u;

const packageVersion = (contents: string): string | undefined =>
  contents.match(VERSION)?.groups?.version;

const isGeneratedRelease = async (base: string): Promise<boolean> => {
  const entries = await readdir(".changeset");
  if (entries.some((file) => file.endsWith(".md"))) {
    return false;
  }
  const previousPackage = Bun.spawnSync([
    "git",
    "show",
    `${base}:package.json`,
  ]);
  if (previousPackage.exitCode !== 0) {
    return false;
  }
  const currentVersion = packageVersion(await Bun.file("package.json").text());
  const previousVersion = packageVersion(
    new TextDecoder().decode(previousPackage.stdout)
  );
  if (
    !currentVersion ||
    !previousVersion ||
    currentVersion === previousVersion
  ) {
    return false;
  }
  const changelog = await Bun.file("CHANGELOG.md").text();
  return changelog
    .split("\n")
    .some((line) => line.trim() === `## ${currentVersion}`);
};

if (head.exitCode === 0 && baseRef) {
  if (await isGeneratedRelease(baseRef)) {
    console.info("Validated generated Changesets release commit.");
  } else {
    const status = Bun.spawnSync(
      ["bunx", "changeset", "status", `--since=${baseRef}`],
      {
        stderr: "inherit",
        stdout: "inherit",
      }
    );
    process.exitCode = status.exitCode;
  }
} else {
  const config = z
    .object({ baseBranch: z.string().optional() })
    .passthrough()
    .parse(parse(await Bun.file(".changeset/config.json").text()));
  if (config.baseBranch !== "main") {
    console.error(".changeset/config.json must target main");
    process.exitCode = 1;
  }

  const entries = await readdir(".changeset");
  const files = entries.filter((file) => file.endsWith(".md"));
  const changesets = await Promise.all(
    files.map((file) => Bun.file(`.changeset/${file}`).text())
  );
  const initial = changesets.some((contents) =>
    /^---\r?\n["']?alchemy-deploy["']?: major\r?\n---\r?\n/u.test(contents)
  );
  if (initial) {
    console.info(
      "Validated initial 1.0.0 Changeset before the first main branch exists."
    );
  } else {
    console.error("Missing initial major changeset for alchemy-deploy");
    process.exitCode = 1;
  }
}
