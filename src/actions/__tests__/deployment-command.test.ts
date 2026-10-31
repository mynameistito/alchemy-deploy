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
    "INPUT_WORKER_SECRETS",
    "INPUT_WORKER-SECRETS",
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
    Bun.env.ALCHEMY_WORKER_SECRETS = "synthetic-preview-secret";
    Bun.env.INPUT_WORKER_SECRETS = "synthetic-preview-secret";
    Bun.env["INPUT_WORKER-SECRETS"] = "synthetic-preview-secret";
    Bun.env.PHASE = "deploy";

    const result = await runConsumerCommand({
      command:
        'test -z "$OP_SERVICE_ACCOUNT_TOKEN" && test -z "$OP_CONNECT_TOKEN" && test -z "$GITHUB_TOKEN" && test -z "$GH_TOKEN" && test -z "$ALCHEMY_WORKER_SECRETS" && test -z "$INPUT_WORKER_SECRETS" && test -z "$(printenv INPUT_WORKER-SECRETS)" && test "$CLOUDFLARE_API_TOKEN" = synthetic-cloudflare-token',
      environment: {
        GITHUB_TOKEN: "synthetic-command-github",
        OP_SERVICE_ACCOUNT_TOKEN: "synthetic-command-bootstrap",
      },
      logPath: path.join(directory, "consumer.log").replaceAll("\\", "/"),
    });

    expect(result).toEqual({ _tag: "ok", value: "success" });
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
