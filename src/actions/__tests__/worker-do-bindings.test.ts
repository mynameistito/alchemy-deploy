import { describe, expect, test } from "bun:test";

import { parseDurableObjectBindings } from "@/worker-do-bindings.ts";

describe("Preview Durable Objects", () => {
  test("creates local SQLite binding for a PR", () => {
    const result = parseDurableObjectBindings(
      { ALCHEMY_WORKER_DO_BINDINGS: '{"CACHE":{"className":"ServerCacheDO"}}' },
      "pr-123"
    );

    expect(result._tag).toBe("ok");

    if (result._tag === "ok") {
      expect(result.value.CACHE).toMatchObject({
        className: "ServerCacheDO",
        kind: "Cloudflare.DurableObject",
        storage: "sqlite",
      });
    }
  });
  test("rejects collisions, invalid classes and non-PR stages", () => {
    const value = '{"CACHE":{"className":"ServerCacheDO"}}';

    for (const env of [
      {
        ALCHEMY_WORKER_CONFIG: '{"CACHE":"x"}',
        ALCHEMY_WORKER_DO_BINDINGS: value,
      },
      {
        ALCHEMY_WORKER_DO_BINDINGS: value,
        ALCHEMY_WORKER_STATE_BINDINGS: '{"CACHE":{}}',
      },
      {
        ALCHEMY_WORKER_DO_BINDINGS: value,
        ALCHEMY_WORKER_RATE_LIMIT_BINDINGS: '{"CACHE":{}}',
      },
      { ALCHEMY_WORKER_DO_BINDINGS: '{"CACHE":{"className":"bad-name"}}' },
      {
        ALCHEMY_WORKER_DO_BINDINGS:
          '{"CACHE":{"className":"X","scriptName":"prod"}}',
      },
    ]) {
      expect(parseDurableObjectBindings(env, "pr-123")._tag).toBe("err");
    }

    expect(
      parseDurableObjectBindings({ ALCHEMY_WORKER_DO_BINDINGS: value }, "prod")
        ._tag
    ).toBe("err");
  });
});
