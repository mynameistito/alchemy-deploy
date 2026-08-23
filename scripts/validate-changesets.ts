import { readdir } from "node:fs/promises";
import { parse } from "yaml";

const head = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], {
  stderr: "ignore",
  stdout: "ignore",
});

if (head.exitCode === 0) {
  const status = Bun.spawnSync(["bunx", "changeset", "status"], {
    stderr: "inherit",
    stdout: "inherit",
  });
  process.exitCode = status.exitCode;
} else {
  const config: unknown = parse(await Bun.file(".changeset/config.json").text());
  if (
    typeof config !== "object" ||
    config === null ||
    !("baseBranch" in config) ||
    config.baseBranch !== "main"
  ) {
    console.error(".changeset/config.json must target main");
    process.exitCode = 1;
  }

  const entries = await readdir(".changeset");
  const files = entries.filter((file) => file.endsWith(".md"));
  const changesets = await Promise.all(files.map((file) => Bun.file(`.changeset/${file}`).text()));
  const initial = changesets.some((contents) =>
    /^---\r?\n["']?alchemy-deploy["']?: major\r?\n---\r?\n/u.test(contents),
  );
  if (initial) {
    console.info("Validated initial 1.0.0 Changeset in unborn repository.");
  } else {
    console.error("Missing initial major changeset for alchemy-deploy");
    process.exitCode = 1;
  }
}
