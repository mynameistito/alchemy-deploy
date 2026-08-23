import { describe, expect, test } from "bun:test";
import { parseReportEnvironment } from "../report-input.ts";

const base = {
  DEPLOYMENT_SHA: "c".repeat(40),
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_REPOSITORY_OWNER: "owner",
  GITHUB_RUN_ID: "123",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_TOKEN: "token",
  STAGE: "pr-42",
  WORKER_NAME: "worker",
} as const;

describe("report action input", () => {
  test("parses a complete command only with its mode-specific fields", () => {
    const result = parseReportEnvironment(
      {
        ...base,
        DEPLOYMENT_ID: "123",
        DEPLOYMENT_URL: "https://worker.example.com",
        DEPLOY_OUTCOME: "success",
        LOGS_URL: "https://dash.cloudflare.com/logs",
        MODE: "complete",
      },
      new Date(0),
    );
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect(result.value.command._tag).toBe("complete");
    }
  });

  test("returns expected errors for missing and malformed boundaries", () => {
    expect(parseReportEnvironment({ ...base, MODE: "delete" }, new Date(0))._tag).toBe("err");
    expect(
      parseReportEnvironment(
        {
          ...base,
          DEPLOY_OUTCOME: "success",
          LOGS_URL: "https://dash.cloudflare.com/logs",
          MODE: "comment",
          PULL_REQUEST_NUMBER: "0",
        },
        new Date(0),
      )._tag,
    ).toBe("err");
  });

  test("rejects non-HTTPS report links", () => {
    const result = parseReportEnvironment(
      {
        ...base,
        DEPLOYMENT_ID: "123",
        DEPLOYMENT_URL: "http://worker.example.com",
        DEPLOY_OUTCOME: "success",
        LOGS_URL: "https://dash.cloudflare.com/logs",
        MODE: "complete",
      },
      new Date(0),
    );
    expect(result._tag).toBe("err");
  });
});
