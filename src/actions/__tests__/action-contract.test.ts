import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse } from "yaml";
import { z } from "zod";

const record = z.record(z.string(), z.json());
type YamlRecord = z.infer<typeof record>;

const getCommandLines = (steps: readonly YamlRecord[]): string[] =>
  steps.map((step) => String(step.run ?? ""));

const action = async () =>
  record.parse(parse(await readFile("action.yml", "utf-8")));

const reportAction = async () =>
  record.parse(
    parse(await readFile("actions/deployment-report/action.yml", "utf-8"))
  );
const actionPathExpression = ["$", "{{ github.action_path }}"].join("");
const githubExpression = (value: string): string =>
  ["$", `{{ ${value} }}`].join("");

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
const inputsFor = (metadata: YamlRecord) => record.parse(metadata.inputs);
const outputsFor = (metadata: YamlRecord) => record.parse(metadata.outputs);

const indexOfStep = (steps: readonly YamlRecord[], name: string): number => {
  const index = steps.findIndex((step) => step.name === name);
  if (index === -1) {
    throw new Error(`missing action step: ${name}`);
  }
  return index;
};

describe("composite action contract", () => {
  test("installs dependencies from the action repository", async () => {
    const metadata = await action();
    const steps = stepsFor(metadata);
    const install = stepNamed(steps, "Install trusted action dependencies");

    expect(install["working-directory"]).toBe(actionPathExpression);
    expect(install.run).toBe("bun install --frozen-lockfile --ignore-scripts");

    const reportMetadata = await reportAction();
    const reportSteps = stepsFor(reportMetadata);
    const reportSetup = stepNamed(
      reportSteps,
      "Set up Bun for deployment reporting"
    );
    const reportInstall = stepNamed(
      reportSteps,
      "Install trusted action dependencies"
    );
    expect(reportSetup.uses).toBe(
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"
    );
    expect(reportSetup.with).toEqual({ "bun-version": "1.4.0" });
    expect(reportInstall["working-directory"]).toBe(
      `${actionPathExpression}/../..`
    );
    expect(
      indexOfStep(reportSteps, "Set up Bun for deployment reporting")
    ).toBeLessThan(indexOfStep(reportSteps, "Report deployment"));
  });

  test("starts both entrypoints from a clean workspace", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alchemy-deploy-"));
    const repository = path.resolve(".");
    const policyEntrypoint = path.join(
      repository,
      "src",
      "actions",
      "deployment-policy-main.ts"
    );
    const reportEntrypoint = path.join(
      repository,
      "src",
      "actions",
      "deployment-report-main.ts"
    );
    const policyOutput = path.join(directory, "policy-output.txt");
    const orchestrationOutput = path.join(
      directory,
      "orchestration-output.txt"
    );
    const reportOutput = path.join(directory, "report-output.txt");

    const run = async (
      entrypoint: string,
      environment: Record<string, string>
    ) => {
      const process = Bun.spawn(["bun", entrypoint], {
        cwd: directory,
        env: { ...Bun.env, ...environment },
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ]);
      return { exitCode, stderr };
    };

    try {
      const policy = await run(policyEntrypoint, {
        GITHUB_OUTPUT: policyOutput,
        GITHUB_TOKEN: "",
      });
      const orchestration = await run(
        policyEntrypoint.replace(
          "deployment-policy-main.ts",
          "deployment-orchestration-main.ts"
        ),
        {
          GITHUB_OUTPUT: orchestrationOutput,
          PHASE: "",
        }
      );
      const report = await run(reportEntrypoint, {
        GITHUB_OUTPUT: reportOutput,
        MODE: "invalid",
      });

      expect(policy.exitCode).toBe(1);
      expect(policy.stderr).toContain("GITHUB_TOKEN is required");
      expect(orchestration.exitCode).toBe(1);
      expect(orchestration.stderr).toContain("PHASE is required");
      expect(report.exitCode).toBe(1);
      expect(report.stderr).toContain("Invalid deployment-report input");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("uses TypeScript runtimes for policy and orchestration", async () => {
    const metadata = await action();
    const steps = stepsFor(metadata);
    const commands = getCommandLines(steps);

    expect(commands).toContain(
      'bun "$GITHUB_ACTION_PATH/src/actions/deployment-policy-main.ts"'
    );
    expect(commands).toContain(
      'bun "$GITHUB_ACTION_PATH/src/actions/deployment-orchestration-main.ts"'
    );
    expect(commands.join("\n")).not.toContain("gh api");
    expect(commands.join("\n")).not.toContain("preview-url-pattern");
  });

  test("maps public inputs and policy outputs without shell policy", async () => {
    const metadata = await action();
    const inputs = inputsFor(metadata);
    const steps = stepsFor(metadata);
    const resolve = stepNamed(steps, "Resolve and gate deployment target");
    const resolveEnv = envFor(resolve);
    const orchestration = stepNamed(
      steps,
      "Run typed deployment orchestration"
    );
    const orchestrationEnv = envFor(orchestration);

    const expectedInputs = {
      "ci-workflow": { default: "ci.yml", required: false },
      "deploy-command": { required: true },
      "destroy-command": { required: true },
      "install-command": {
        default: "bun install --frozen-lockfile",
        required: false,
      },
      "preview-url-pattern": {
        default: "https://{worker}-{stage}.*.workers.dev",
        required: false,
      },
      "production-branch": { default: "main", required: false },
      "production-stage": { default: "prod", required: false },
      "production-url": { required: true },
      "use-adopt": { default: false, required: false },
      "worker-config": { default: "", required: false },
      "worker-name": { required: true },
    } as const;
    for (const [name, contract] of Object.entries(expectedInputs)) {
      const input = record.parse(inputs[name]);
      expect(input.required).toBe(contract.required);
      if ("default" in contract) {
        expect(input.default).toBe(contract.default);
      }
    }
    expect(resolveEnv.CI_WORKFLOW).toContain("inputs.ci-workflow");
    expect(resolveEnv.PRODUCTION_BRANCH).toContain("inputs.production-branch");
    expect(resolveEnv.PRODUCTION_STAGE).toContain("inputs.production-stage");
    expect(resolveEnv.PULL_REQUEST_HEAD_REPOSITORY_ID).toContain(
      "head.repo.id"
    );
    expect(resolveEnv.REPOSITORY_ID).toContain("github.repository_id");
    expect(resolveEnv.WORKFLOW_RUN_ID).toContain("workflow_run.workflow_id");
    expect(orchestrationEnv.PREVIEW_PATTERN).toContain(
      "inputs.preview-url-pattern"
    );
    expect(orchestrationEnv.PRODUCTION_URL).toContain("inputs.production-url");
    expect(orchestration.if).toBe(
      "success() && (steps.resolve.outputs.deploy == 'true' || steps.resolve.outputs.cleanup == 'true')"
    );

    expect(resolve.id).toBe("resolve");
    expect(indexOfStep(steps, "Check out exact consumer commit")).toBeLessThan(
      indexOfStep(steps, "Run typed deployment orchestration")
    );
    expect(orchestration.if).toContain("steps.resolve.outputs.deploy");
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

  test("declares report inputs and output sources structurally", async () => {
    const metadata = await reportAction();
    const inputs = inputsFor(metadata);
    const outputs = outputsFor(metadata);
    const expectedInputs = {
      "deploy-outcome": { required: false },
      "deployment-id": { required: false },
      "deployment-sha": { required: true },
      "deployment-url": { required: false },
      mode: { required: true },
      "production-stage": { default: "prod", required: false },
      "pull-request-number": { required: false },
      stage: { required: true },
      "worker-name": { required: true },
    } as const;
    for (const [name, contract] of Object.entries(expectedInputs)) {
      const input = record.parse(inputs[name]);
      expect(input.required).toBe(contract.required);
      if ("default" in contract) {
        expect(input.default).toBe(contract.default);
      }
    }
    for (const [name, source] of [
      ["deployment-id", githubExpression("steps.report.outputs.deployment-id")],
      [
        "deleted-deployments",
        githubExpression("steps.report.outputs.deleted-deployments"),
      ],
    ] as const) {
      expect(record.parse(outputs[name]).value).toBe(source);
    }
    const report = stepNamed(stepsFor(metadata), "Report deployment");
    expect(report.id).toBe("report");
    expect(envFor(report)).toMatchObject({
      DEPLOYMENT_SHA: githubExpression("inputs.deployment-sha"),
      MODE: githubExpression("inputs.mode"),
      STAGE: githubExpression("inputs.stage"),
    });
  });

  test("does not expose GitHub credentials to consumer-controlled commands", async () => {
    const steps = stepsFor(await action());
    const environment = envFor(
      stepNamed(steps, "Run typed deployment orchestration")
    );
    expect(environment.GITHUB_TOKEN).toContain("env.GITHUB_TOKEN");
    expect(environment.CLOUDFLARE_API_TOKEN).toContain(
      "env.CLOUDFLARE_API_TOKEN"
    );
    expect(environment.CLOUDFLARE_ACCOUNT_ID).toContain(
      "env.CLOUDFLARE_ACCOUNT_ID"
    );
  });

  test("keeps consumer execution on the Bash compatibility boundary", async () => {
    const steps = stepsFor(await action());
    const orchestration = stepNamed(
      steps,
      "Run typed deployment orchestration"
    );
    const source = await readFile(
      "src/actions/deployment-orchestration-main.ts",
      "utf-8"
    );

    expect(orchestration.shell).toBe("bash");
    expect(source).toContain("bash");
    expect(source).toContain("-euo");
    expect(source).toContain("pipefail");
    expect(source).toContain("tee");
  });

  test("clears deployment credentials from trusted setup and install steps", async () => {
    const steps = stepsFor(await action());
    for (const name of [
      "Set up Bun for policy resolution",
      "Install trusted action dependencies",
      "Set up Bun",
      "Install dependencies",
    ]) {
      const environment = envFor(stepNamed(steps, name));
      expect(environment.GITHUB_TOKEN).toBe("");
      expect(environment.CLOUDFLARE_ACCOUNT_ID).toBe("");
      expect(environment.CLOUDFLARE_API_TOKEN).toBe("");
    }
  });
});
