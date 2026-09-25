export interface ConsumerAttemptResult {
  readonly exitCode: number;
  readonly output: string;
}

export type ConsumerAttempt = () => Promise<ConsumerAttemptResult>;

const RETRY_DELAY_MS = 10_000;

/** Match only the known Alchemy state-store failure that occurs during planning. */
export const isRetryableStateStorePlanningFailure = (output: string): boolean =>
  /Planning failed/iu.test(output) &&
  /StateStoreError:\s*State store request failed \(DecodeError,\s*HTTP 500\)/iu.test(
    output
  );

/** Retry once only when Alchemy failed before applying a plan. */
export const runConsumerAttemptWithRetry = async (
  runAttempt: ConsumerAttempt,
  retryEnabled: boolean,
  sleep: (milliseconds: number) => Promise<void> = Bun.sleep
): Promise<"success" | "failure"> => {
  const first = await runAttempt();
  if (first.exitCode === 0) {
    return "success";
  }
  if (!retryEnabled) {
    return "failure";
  }
  if (!isRetryableStateStorePlanningFailure(first.output)) {
    return "failure";
  }

  console.warn(
    "::warning::Alchemy State Store returned HTTP 500 during planning; retrying deployment once."
  );
  await sleep(RETRY_DELAY_MS);

  const second = await runAttempt();
  return second.exitCode === 0 ? "success" : "failure";
};
