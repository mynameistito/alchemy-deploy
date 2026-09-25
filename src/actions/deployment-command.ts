import { appendFile, readFile, writeFile } from "node:fs/promises";

import { runConsumerAttemptWithRetry } from "@/actions/consumer-command.ts";
import type { ConsumerCommand } from "@/application/deployment-orchestration.ts";
import { err, ok } from "@/shared/result.ts";
import type { Result } from "@/shared/result.ts";

/** Read a required environment variable supplied by the composite action. */
export const required = (name: string): Result<string, Error> => {
  const value = Bun.env[name]?.trim();
  return value ? ok(value) : err(new Error(`${name} is required`));
};

const environmentFor = (command: ConsumerCommand) => {
  const environment = {
    ...command.environment,
    ALCHEMY_WORKER_CONFIG: Bun.env.ALCHEMY_WORKER_CONFIG ?? "",
    CLOUDFLARE_ACCOUNT_ID: Bun.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    CLOUDFLARE_API_TOKEN: Bun.env.CLOUDFLARE_API_TOKEN ?? "",
    GITHUB_TOKEN: "",
    STAGE: command.environment.STAGE ?? "",
  } satisfies Record<string, string>;
  return environment;
};

/**
 * Run one consumer command through the Bash compatibility boundary, streaming
 * combined output to its log file. `GITHUB_TOKEN` is cleared so a consumer
 * command can never reach the workflow token.
 */
export const runConsumerCommand = async (
  command: ConsumerCommand
): Promise<Result<"success" | "failure", Error>> => {
  await writeFile(command.logPath, "", "utf-8");
  const outcome = await runConsumerAttemptWithRetry(async () => {
    const process = Bun.spawn(
      [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        'bash -euo pipefail -c "$CONSUMER_COMMAND" 2>&1 | tee -a "$LOG_PATH"',
      ],
      {
        env: {
          ...Bun.env,
          ...environmentFor(command),
          CONSUMER_COMMAND: command.command,
          LOG_PATH: command.logPath,
        },
        stderr: "inherit",
        stdout: "inherit",
      }
    );
    const exitCode = await process.exited;
    return { exitCode, output: await readFile(command.logPath, "utf-8") };
  }, Bun.env.PHASE === "deploy");
  return ok(outcome);
};

/** Preserve diagnostics when a failed phase cannot report them to GitHub. */
export const diagnostic = async (message: string): Promise<void> => {
  const path = Bun.env.GITHUB_STEP_SUMMARY;
  if (path) {
    await appendFile(
      path,
      `## Alchemy deployment diagnostics\n\n${message}\n`,
      "utf-8"
    );
  }
};
