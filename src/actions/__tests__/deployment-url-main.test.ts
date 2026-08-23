import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runDeploymentUrl } from "@/actions/deployment-url-main.ts";

const base = {
  ACCOUNT_ID: "account/id",
  OUTCOME: "success",
  PREVIEW_PATTERN: "https://{worker}-{stage}.*.workers.dev",
  PRODUCTION_STAGE: "prod",
  PRODUCTION_URL: "https://worker.example.com/path",
  STAGE: "pr-42",
  WORKER: "worker",
} as const;

const fixture = async (log: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), "alchemy-deploy-"));
  const logPath = path.join(directory, "alchemy-deploy.log");
  const outputPath = path.join(directory, "github-output");
  await writeFile(logPath, log);
  return { LOG_PATH: logPath, outputPath };
};

describe("deployment URL action entrypoint", () => {
  test("reads deployment output and writes preview and logs links", async () => {
    const paths = await fixture(
      "noise (https://worker-pr-42.foo.workers.dev)."
    );
    expect(
      await runDeploymentUrl({
        ...base,
        ...paths,
        GITHUB_OUTPUT: paths.outputPath,
      })
    ).toBe(0);
    expect(await readFile(paths.outputPath, "utf-8")).toBe(
      "logs-url=https://dash.cloudflare.com/?to=/account%2Fid/workers/services/view/worker-pr-42/production/logs\n" +
        "deployment-url=https://worker-pr-42.foo.workers.dev\n"
    );
  });

  test("uses the exact production URL and skips log parsing", async () => {
    const paths = await fixture("not a URL");
    expect(
      await runDeploymentUrl({
        ...base,
        ...paths,
        GITHUB_OUTPUT: paths.outputPath,
        STAGE: "prod",
      })
    ).toBe(0);
    expect(await readFile(paths.outputPath, "utf-8")).toContain(
      "deployment-url=https://worker.example.com\n"
    );
  });

  test("writes logs for a failed deployment without requiring a deployment URL", async () => {
    const paths = await fixture("");
    expect(
      await runDeploymentUrl({
        ...base,
        ...paths,
        GITHUB_OUTPUT: paths.outputPath,
        OUTCOME: "failure",
      })
    ).toBe(0);
    expect(await readFile(paths.outputPath, "utf-8")).toMatch(/^logs-url=/u);
  });

  test("rejects malformed, insecure, unmatched, and incomplete input", async () => {
    const paths = await fixture("https://worker-pr-42.foo.workers.dev");
    const cases = [
      { ...base, ...paths, PREVIEW_PATTERN: "https://*.workers.dev" },
      {
        ...base,
        ...paths,
        PRODUCTION_URL: "http://worker.example.com",
        STAGE: "prod",
      },
      { ...base, ...paths, ACCOUNT_ID: "" },
      { ...base, ...paths, WORKER: "" },
      { ...base, ...paths, STAGE: "pr-41" },
    ];
    const results = await Promise.all(
      cases.map((input) =>
        runDeploymentUrl({ ...input, GITHUB_OUTPUT: paths.outputPath })
      )
    );
    expect(results).toEqual([1, 1, 1, 1, 1]);
  });
});
