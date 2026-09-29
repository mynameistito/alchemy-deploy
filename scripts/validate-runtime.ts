import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse } from "yaml";
import { z } from "zod";

const record = z.record(z.string(), z.json());
const actionPaths = ["action.yml", "actions/deployment-report/action.yml"];
const runPath = /\$GITHUB_ACTION_PATH\/(?:\.\.\/)*[^"'\s$]+/gu;
const packageJsonSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  packageManager: z.string().optional(),
});

const runAlchemyCliHelp = async () => {
  const workingDirectory = await mkdtemp(
    path.join(tmpdir(), "alchemy-runtime-validation-")
  );
  try {
    return Bun.spawnSync(
      [
        "bun",
        path.resolve("node_modules/alchemy/bin/cli.js"),
        "destroy",
        "--help",
      ],
      {
        cwd: workingDirectory,
        env: {
          ...Bun.env,
          ALCHEMY_HOME: path.join(workingDirectory, "home"),
          ALCHEMY_TELEMETRY_DISABLED: "1",
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
  } finally {
    await rm(workingDirectory, { force: true, recursive: true });
  }
};

const failures: string[] = [];
const packageText = await Bun.file("package.json").text();
const packageJson = packageJsonSchema.parse(JSON.parse(packageText));
const lockFile = Bun.file("bun.lock");
const lockText = (await lockFile.exists()) ? await lockFile.text() : "";
const alchemyCli = await runAlchemyCliHelp();

if (alchemyCli.exitCode !== 0) {
  failures.push(
    `Alchemy CLI could not start: ${alchemyCli.stderr.toString("utf-8")}`
  );
}

if (packageJson.packageManager !== "bun@1.4.2") {
  failures.push("package.json: packageManager must pin bun@1.4.2");
}
if (!lockText) {
  failures.push("bun.lock: required by action dependency installation");
}

for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
  if (!lockText.includes(`"${dependency}":`)) {
    failures.push(`bun.lock: runtime dependency is absent: ${dependency}`);
  }
}

const metadataFiles = await Promise.all(
  actionPaths.map(async (actionPath) => ({
    actionPath,
    metadata: record.parse(parse(await readFile(actionPath, "utf-8"))),
  }))
);
const runtimeFiles: readonly { actionPath: string; resolved: string }[] =
  metadataFiles.flatMap(({ actionPath, metadata }) => {
    const runs = record.parse(metadata.runs);
    const steps = z.array(record).parse(runs.steps);
    return steps.flatMap((step) => {
      const run = z.string().safeParse(step.run);
      if (!run.success) {
        return [];
      }
      return [...run.data.matchAll(runPath)].map((reference) => {
        const relativePath = reference[0].slice("$GITHUB_ACTION_PATH/".length);
        return {
          actionPath,
          resolved: path.normalize(
            path.join(path.dirname(actionPath), relativePath)
          ),
        };
      });
    });
  });
const runtimeFileResults = await Promise.all(
  runtimeFiles.map(async (runtimeFile) => ({
    ...runtimeFile,
    exists: await Bun.file(runtimeFile.resolved).exists(),
  }))
);
for (const runtimeFile of runtimeFileResults) {
  if (!runtimeFile.exists) {
    failures.push(
      `${runtimeFile.actionPath}: runtime file is absent: ${runtimeFile.resolved}`
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exitCode = 1;
} else {
  console.info(`Validated runtime paths for ${actionPaths.length} actions.`);
}
