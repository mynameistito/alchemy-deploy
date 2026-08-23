import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { z } from "zod";

const record = z.record(z.string(), z.json());
type YamlRecord = z.infer<typeof record>;

const getCommandLines = (steps: readonly YamlRecord[]): string[] =>
  steps.map((step) => String(step.run ?? ""));

const action = async () =>
  record.parse(parse(await readFile("action.yml", "utf-8")));

const stepsFor = (metadata: YamlRecord) => {
  const runs = record.parse(metadata.runs);
  return z.array(record).parse(runs.steps);
};

const stepNamed = (steps: readonly YamlRecord[], name: string): YamlRecord => {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`missing action step: ${name}`);
  }
  return step;
};

const envFor = (step: YamlRecord) => record.parse(step.env);

describe("composite action contract", () => {
  test("uses TypeScript runtimes for policy, reporting, and URL resolution", async () => {
    const metadata = await action();
    const steps = stepsFor(metadata);
    const commands = getCommandLines(steps);

    expect(commands).toContain(
      'bun "$GITHUB_ACTION_PATH/src/actions/deployment-policy-main.ts"'
    );
    expect(commands).toContain(
      'bun "$GITHUB_ACTION_PATH/src/actions/deployment-url-main.ts"'
    );
    expect(
      commands.filter((line) =>
        line.includes("src/actions/deployment-report-main.ts")
      )
    ).toHaveLength(4);
    expect(commands.join("\n")).not.toContain("gh api");
    expect(commands.join("\n")).not.toContain("preview-url-pattern");
  });

  test("maps public inputs and policy outputs without shell policy", async () => {
    const metadata = await action();
    const inputs = record.parse(metadata.inputs);
    const steps = stepsFor(metadata);
    const resolve = stepNamed(steps, "Resolve and gate deployment target");
    const resolveEnv = envFor(resolve);
    const links = stepNamed(steps, "Resolve deployment links");
    const linksEnv = envFor(links);

    for (const input of [
      "ci-workflow",
      "production-branch",
      "production-stage",
      "preview-url-pattern",
      "worker-name",
    ]) {
      expect(inputs[input]).toBeDefined();
    }
    const metadataText = JSON.stringify(metadata);
    for (const input of Object.keys(inputs)) {
      expect(metadataText).toContain(`inputs.${input}`);
    }
    expect(resolveEnv.CI_WORKFLOW).toContain("inputs.ci-workflow");
    expect(resolveEnv.PRODUCTION_BRANCH).toContain("inputs.production-branch");
    expect(resolveEnv.PRODUCTION_STAGE).toContain("inputs.production-stage");
    expect(resolveEnv.PULL_REQUEST_HEAD_REPOSITORY_ID).toContain(
      "head.repo.id"
    );
    expect(resolveEnv.REPOSITORY_ID).toContain("github.repository_id");
    expect(resolveEnv.WORKFLOW_RUN_ID).toContain("workflow_run.workflow_id");
    expect(linksEnv.PREVIEW_PATTERN).toContain("inputs.preview-url-pattern");
    expect(linksEnv.PRODUCTION_URL).toContain("inputs.production-url");
    expect(metadataText).toContain("steps.resolve.outputs.deploy");
    expect(metadataText).toContain("steps.resolve.outputs.cleanup");
    expect(metadataText).toContain("steps.resolve.outputs.stage");
    expect(metadataText).toContain("steps.resolve.outputs.preview");
    expect(metadataText).toContain("steps.create.outputs.deployment-id");
    expect(metadataText).toContain("steps.links.outputs.deployment-url");
    expect(metadataText).toContain("steps.links.outputs.logs-url");

    expect(resolve.id).toBe("resolve");
    expect(
      steps.some((step) => {
        const values = record.safeParse(step.with);
        return (
          values.success &&
          String(values.data.ref ?? "").includes(
            "steps.resolve.outputs.deployment-sha"
          )
        );
      })
    ).toBeTrue();
    expect(getCommandLines(steps)).not.toContain("pull_request_target");
  });

  test("does not expose GitHub credentials to consumer-controlled commands", async () => {
    const steps = stepsFor(await action());
    for (const name of ["Deploy Alchemy stack", "Destroy preview stack"]) {
      const environment = envFor(stepNamed(steps, name));
      expect(environment.GITHUB_TOKEN).toBe("");
      expect(environment.CLOUDFLARE_API_TOKEN).toContain(
        "env.CLOUDFLARE_API_TOKEN"
      );
      expect(environment.CLOUDFLARE_ACCOUNT_ID).toContain(
        "env.CLOUDFLARE_ACCOUNT_ID"
      );
    }
  });
});
