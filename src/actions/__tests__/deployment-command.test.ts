import { expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runConsumerCommand } from "@/actions/deployment-command.ts";

test("consumer subprocess receives only the intended deployment credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deploy-env-"));

  const names = [
    "OP_SERVICE_ACCOUNT_TOKEN",
    "GITHUB_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "PHASE",
    "PATH",
  ] as const;

  const previous = names.map((name) => Bun.env[name]);

  try {
    if (process.platform === "win32") {
      // Windows' system Bash is a WSL launcher, not the action's Bash runtime.
      const gitBin = path.join(
        Bun.env.ProgramFiles ?? "C:/Program Files",
        "Git",
        "bin"
      );

      await access(path.join(gitBin, "bash.exe"));
      Bun.env.PATH = `${gitBin}${path.delimiter}${Bun.env.PATH ?? ""}`;
    }

    Bun.env.OP_SERVICE_ACCOUNT_TOKEN = "synthetic-parent-bootstrap";
    Bun.env.GITHUB_TOKEN = "synthetic-workflow-token";
    Bun.env.CLOUDFLARE_API_TOKEN = "synthetic-cloudflare-token";
    Bun.env.PHASE = "deploy";

    const result = await runConsumerCommand({
      command:
        'test -z "$OP_SERVICE_ACCOUNT_TOKEN" && test -z "$GITHUB_TOKEN" && test "$CLOUDFLARE_API_TOKEN" = synthetic-cloudflare-token',
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
