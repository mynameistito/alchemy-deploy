import { describe, expect, test } from "bun:test";
import { parseDeploymentStage, parseWorkerName } from "../deployment.ts";
import { cloudflareLogsUrl, resolveDeploymentUrl } from "../deployment-url.ts";

const fixture = (stageName: string) => {
  const stage = parseDeploymentStage(stageName);
  const worker = parseWorkerName("x-lookup");
  if (stage._tag === "err" || worker._tag === "err") {
    throw new Error("test fixture failed to parse");
  }
  return { stage: stage.value, worker: worker.value };
};

describe("deployment URL resolution", () => {
  test("uses configured production URL without trusting log noise", () => {
    const { stage, worker } = fixture("prod");
    const result = resolveDeploymentUrl("https://attacker.example", stage, worker, {
      previewUrlPattern: "https://{worker}-{stage}.*.workers.dev",
      productionUrl: "https://x-lookup.example.com/path",
    });
    expect(result).toEqual({
      _tag: "ok",
      value: "https://x-lookup.example.com",
    });
  });

  test("selects only the configured stage URL and strips punctuation", () => {
    const { stage, worker } = fixture("pr-42");
    const result = resolveDeploymentUrl(
      "old https://x-lookup-pr-41.foo.workers.dev new (https://x-lookup-pr-42.foo.workers.dev).",
      stage,
      worker,
      {
        previewUrlPattern: "https://{worker}-{stage}.*.workers.dev",
        productionUrl: "https://x-lookup.example.com",
      },
    );
    expect(result).toEqual({
      _tag: "ok",
      value: "https://x-lookup-pr-42.foo.workers.dev",
    });
  });

  test("rejects malformed patterns and builds stage-aware logs", () => {
    const { stage, worker } = fixture("pr-5");
    expect(
      resolveDeploymentUrl("", stage, worker, {
        previewUrlPattern: "https://*.workers.dev",
        productionUrl: "https://example.com",
      })._tag,
    ).toBe("err");
    expect(cloudflareLogsUrl("account/id", worker, stage)).toEqual({
      _tag: "ok",
      value:
        "https://dash.cloudflare.com/?to=/account%2Fid/workers/services/view/x-lookup-pr-5/production/logs",
    });
  });
});
