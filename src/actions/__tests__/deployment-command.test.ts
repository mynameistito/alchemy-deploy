import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runConsumerCommand } from "@/actions/deployment-command.ts";

test("consumer subprocess receives only the intended deployment credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deploy-env-"));

  const names = [
    "OP_SERVICE_ACCOUNT_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "OP_CONNECT_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "ALCHEMY_WORKER_SECRETS",
    "ALCHEMY_WORKER_STATE_BINDINGS",
    "INPUT_WORKER_STATE_BINDINGS",
    "INPUT_WORKER-STATE-BINDINGS",
    "INPUT_WORKER_SECRETS",
    "INPUT_WORKER-SECRETS",
    "ALCHEMY_PREVIEW_STATE_TOKEN",
    "INPUT_PREVIEW_STATE_TOKEN",
    "INPUT_PREVIEW-STATE-TOKEN",
    "PHASE",
    "PATH",
  ] as const;

  const previous = names.map((name) => Bun.env[name]);

  try {
    if (process.platform === "win32") {
      // Windows' system Bash is a WSL launcher, not the action's Bash runtime.
      const gitExecutable = Bun.which("git.exe");

      const roots = [
        gitExecutable ? path.resolve(path.dirname(gitExecutable), "..") : "",
        path.join(Bun.env.ProgramFiles ?? "C:/Program Files", "Git"),
        Bun.env.LOCALAPPDATA
          ? path.join(Bun.env.LOCALAPPDATA, "Programs", "Git")
          : "",
      ].filter(Boolean);

      const gitBin = roots
        .map((root) => path.join(root, "bin"))
        .find((candidate) => existsSync(path.join(candidate, "bash.exe")));

      if (!gitBin) {
        throw new Error("Git Bash is required for the Windows subprocess test");
      }

      Bun.env.PATH = `${gitBin}${path.delimiter}${Bun.env.PATH ?? ""}`;
    }

    Bun.env.OP_SERVICE_ACCOUNT_TOKEN = "synthetic-parent-bootstrap";
    Bun.env.GITHUB_TOKEN = "synthetic-workflow-token";
    Bun.env.GH_TOKEN = "synthetic-alternate-github-token";
    Bun.env.OP_CONNECT_TOKEN = "synthetic-connect-bootstrap";
    Bun.env.CLOUDFLARE_API_TOKEN = "synthetic-cloudflare-token";
    Bun.env.ALCHEMY_WORKER_STATE_BINDINGS = "synthetic-parent-binding";
    Bun.env.INPUT_WORKER_STATE_BINDINGS = "synthetic-parent-binding";
    Bun.env["INPUT_WORKER-STATE-BINDINGS"] = "synthetic-parent-binding";
    Bun.env.ALCHEMY_WORKER_SECRETS = "synthetic-preview-secret";
    Bun.env.INPUT_WORKER_SECRETS = "synthetic-preview-secret";
    Bun.env["INPUT_WORKER-SECRETS"] = "synthetic-preview-secret";
    Bun.env.ALCHEMY_PREVIEW_STATE_TOKEN = "synthetic-state-token";
    Bun.env.INPUT_PREVIEW_STATE_TOKEN = "synthetic-state-token";
    Bun.env["INPUT_PREVIEW-STATE-TOKEN"] = "synthetic-state-token";
    Bun.env.PHASE = "deploy";

    const result = await runConsumerCommand({
      command:
        'test -z "$OP_SERVICE_ACCOUNT_TOKEN" && test -z "$OP_CONNECT_TOKEN" && test -z "$GITHUB_TOKEN" && test -z "$GH_TOKEN" && test -z "$ALCHEMY_WORKER_STATE_BINDINGS" && test -z "$INPUT_WORKER_STATE_BINDINGS" && test -z "$(printenv INPUT_WORKER-STATE-BINDINGS)" && test -z "$ALCHEMY_WORKER_SECRETS" && test -z "$INPUT_WORKER_SECRETS" && test -z "$(printenv INPUT_WORKER-SECRETS)" && test -z "$ALCHEMY_PREVIEW_STATE_TOKEN" && test -z "$INPUT_PREVIEW_STATE_TOKEN" && test -z "$(printenv INPUT_PREVIEW-STATE-TOKEN)" && test "$CLOUDFLARE_API_TOKEN" = synthetic-cloudflare-token',
      environment: {
        GITHUB_TOKEN: "synthetic-command-github",
        OP_SERVICE_ACCOUNT_TOKEN: "synthetic-command-bootstrap",
      },
      logPath: path.join(directory, "consumer.log").replaceAll("\\", "/"),
    });

    expect(result).toEqual({ _tag: "ok", value: "success" });

    const trusted = await runConsumerCommand({
      command:
        'test "$ALCHEMY_WORKER_STATE_BINDINGS" = synthetic-trusted-binding && test -z "$INPUT_WORKER_STATE_BINDINGS" && test -z "$(printenv INPUT_WORKER-STATE-BINDINGS)" && test "$ALCHEMY_PREVIEW_STATE_TOKEN" = synthetic-state-token && test -z "$INPUT_PREVIEW_STATE_TOKEN" && test -z "$(printenv INPUT_PREVIEW-STATE-TOKEN)"',
      environment: {
        ALCHEMY_PREVIEW_STATE_TOKEN: "synthetic-state-token",
        ALCHEMY_WORKER_STATE_BINDINGS: "synthetic-trusted-binding",
      },
      logPath: path.join(directory, "trusted.log").replaceAll("\\", "/"),
    });

    expect(trusted).toEqual({ _tag: "ok", value: "success" });
  } finally {
    for (const [index, name] of names.entries()) {
      const value = previous[index];

      if (value === undefined) {
        Reflect.deleteProperty(Bun.env, name);
      } else {
        Bun.env[name] = value;
      }
    }

    await rm(directory, { force: true, recursive: true });
  }
});
