import { describe, expect, test } from "bun:test";

import {
  isRetryableStateStorePlanningFailure,
  runConsumerAttemptWithRetry,
} from "@/actions/consumer-command.ts";

const stateStorePlanningFailure = [
  "INFO: Planning failed (8.7s)",
  "ERROR: StateStoreError: State store request failed (DecodeError, HTTP 500).",
  "at plan.make (node_modules/alchemy/src/Plan.ts:2112:12)",
].join("\n");

describe("consumer command retry", () => {
  test("recognizes only the failed Alchemy state-store planning signature", () => {
    expect(
      isRetryableStateStorePlanningFailure(stateStorePlanningFailure)
    ).toBe(true);
    expect(
      isRetryableStateStorePlanningFailure(
        "StateStoreError: State store request failed (DecodeError, HTTP 500)."
      )
    ).toBe(false);
    expect(
      isRetryableStateStorePlanningFailure(
        "Planning failed: Cloudflare deployment failed with HTTP 500"
      )
    ).toBe(false);
  });

  test("retries the planning failure once, then succeeds", async () => {
    const outputs = [
      { exitCode: 1, output: stateStorePlanningFailure },
      { exitCode: 0, output: "Deploy complete" },
    ];
    const runAttempt = () => {
      const next = outputs.shift();
      if (!next) {
        return Promise.reject(new Error("unexpected extra attempt"));
      }
      return Promise.resolve(next);
    };
    const delays: number[] = [];

    const result = await runConsumerAttemptWithRetry(
      runAttempt,
      true,
      (duration) => {
        delays.push(duration);
        return Promise.resolve();
      }
    );

    expect(result).toBe("success");
    expect(delays).toEqual([10_000]);
    expect(outputs).toHaveLength(0);
  });

  test("does not retry unrelated failures or successful commands", async () => {
    let attempts = 0;
    const unrelatedFailure = await runConsumerAttemptWithRetry(
      () => {
        attempts += 1;
        return Promise.resolve({
          exitCode: 1,
          output: "deployment apply failed",
        });
      },
      true,
      () => Promise.resolve()
    );
    expect(unrelatedFailure).toBe("failure");
    expect(attempts).toBe(1);

    const success = await runConsumerAttemptWithRetry(
      () => {
        attempts += 1;
        return Promise.resolve({ exitCode: 0, output: "Deploy complete" });
      },
      true,
      () => Promise.resolve()
    );
    expect(success).toBe("success");
    expect(attempts).toBe(2);
  });

  test("fails after one retry without starting a third attempt", async () => {
    let attempts = 0;
    const result = await runConsumerAttemptWithRetry(
      () => {
        attempts += 1;
        return Promise.resolve({
          exitCode: 1,
          output: stateStorePlanningFailure,
        });
      },
      true,
      () => Promise.resolve()
    );

    expect(result).toBe("failure");
    expect(attempts).toBe(2);
  });

  test("does not retry cleanup commands", async () => {
    let attempts = 0;
    const result = await runConsumerAttemptWithRetry(
      () => {
        attempts += 1;
        return Promise.resolve({
          exitCode: 1,
          output: stateStorePlanningFailure,
        });
      },
      false,
      () => Promise.resolve()
    );

    expect(result).toBe("failure");
    expect(attempts).toBe(1);
  });
});
