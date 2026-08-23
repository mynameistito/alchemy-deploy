import { describe, expect, test } from "bun:test";

import {
  parseCommitSha,
  parseDeploymentStage,
  parseWorkerName,
  physicalWorkerName,
} from "@/domain/deployment.ts";

describe("deployment input parsing", () => {
  test("parses only production and isolated preview stages", () => {
    expect(parseDeploymentStage("prod")).toEqual({
      _tag: "ok",
      value: { _tag: "production", value: "prod" },
    });
    expect(parseDeploymentStage("pr-42")).toEqual({
      _tag: "ok",
      value: { _tag: "preview", pullRequest: 42, value: "pr-42" },
    });
    expect(parseDeploymentStage("production")._tag).toBe("err");
    expect(parseDeploymentStage("pr-0")._tag).toBe("err");
    expect(parseDeploymentStage("pr-1-extra")._tag).toBe("err");
  });

  test("supports a configured production stage without weakening preview isolation", () => {
    expect(parseDeploymentStage("production", "production")).toEqual({
      _tag: "ok",
      value: { _tag: "production", value: "production" },
    });
    expect(parseDeploymentStage("prod", "production")._tag).toBe("err");
    expect(parseDeploymentStage("pr-7", "pr-7")._tag).toBe("err");
    expect(
      parseDeploymentStage("production", "production; echo unsafe")._tag
    ).toBe("err");
  });

  test("requires full lowercase SHAs and safe Worker names", () => {
    expect(parseCommitSha("a".repeat(40))._tag).toBe("ok");
    expect(parseCommitSha("A".repeat(40))._tag).toBe("err");
    expect(parseCommitSha("a".repeat(39))._tag).toBe("err");
    expect(parseWorkerName("x-lookup")._tag).toBe("ok");
    expect(parseWorkerName("X lookup")._tag).toBe("err");
  });

  test("qualifies only preview physical names", () => {
    const worker = parseWorkerName("x-lookup");
    const preview = parseDeploymentStage("pr-7");
    if (worker._tag === "err" || preview._tag === "err") {
      throw new Error("test fixture failed to parse");
    }
    expect(physicalWorkerName(worker.value, preview.value)).toBe(
      "x-lookup-pr-7"
    );
  });
});
