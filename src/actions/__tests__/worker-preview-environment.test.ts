/* oxlint-disable anti-slop/no-unknown-parameters -- This adapter records provider output without interpreting its shape. */
import { describe, expect, test } from "bun:test";

import { runPromise, sync } from "effect/Effect";
import type { Effect } from "effect/Effect";
import { isRedacted } from "effect/Redacted";

import { parsePreviewEnvironment } from "@/worker-preview-environment.ts";

describe("Preview environment", () => {
  test("defaults to the existing empty environment", () => {
    expect(parsePreviewEnvironment("", "")).toEqual({ _tag: "ok", value: {} });
  });

  test("rejects invalid, duplicate and overlapping keys without echoing input", () => {
    for (const [publicValues, secrets] of [
      ["{}", '{"PRIVATE":"sentinel", "PRIVATE":"other"}'],
      ['{"A":1,"A":2}', "{}"],
      ['{"PRIVATE":1}', '{"PRIVATE":"sentinel"}'],
      ["{}", '{"PRIVATE":123}'],
      ["{}", '{"PRIVATE":"sentinel"'],
      ["{}", '{"__proto__":"sentinel"}'],
      ["{}", '{"bad-name":"sentinel"}'],
      ["{}", '{"ALCHEMY_STAGE":"sentinel"}'],
      ["[]", "{}"],
    ] as const) {
      const result = parsePreviewEnvironment(publicValues, secrets);
      expect(result._tag).toBe("err");
      expect(JSON.stringify(result)).not.toContain("sentinel");
    }
  });

  test("the pinned Worker's real binding classifier emits secret_text", async () => {
    const parsed = parsePreviewEnvironment(
      '{"PUBLIC":"hello","OBJECT":{"type":"d1"}}',
      '{"PRIVATE":"example"}'
    );

    if (parsed._tag === "err") {
      throw parsed.error;
    }

    expect(isRedacted(parsed.value.PRIVATE)).toBeTrue();
    const bindings: unknown[] = [];

    // The provider's source export is loaded dynamically to avoid typechecking its
    // unpublished TypeScript internals with this project's stricter settings.
    const providerPath = [
      "../../../node_modules/@alchemy.run/cloudflare/src/Workers",
      "WorkerAsyncBindings.ts",
    ].join("/");

    const provider: {
      // oxlint-disable-next-line anti-slop(no-unknown-parameters)
      bindWorkerAsyncBindings: (
        resource: unknown,
        props: unknown
      ) => Effect<void>;
    } = await import(providerPath);

    const resource = {
      Mode: "remote",
      // oxlint-disable-next-line anti-slop(no-unknown-parameters)
      bind: () => (data: unknown) =>
        sync(() => {
          bindings.push(data);
        }),
    };

    await runPromise(
      provider.bindWorkerAsyncBindings(resource, { env: parsed.value })
    );
    expect(bindings).toContainEqual(
      expect.objectContaining({
        bindings: [{ name: "PRIVATE", text: "example", type: "secret_text" }],
      })
    );
    expect(bindings).toContainEqual(
      expect.objectContaining({
        bindings: [{ name: "PUBLIC", text: "hello", type: "plain_text" }],
      })
    );
    expect(bindings).toContainEqual(
      expect.objectContaining({
        bindings: [{ json: { type: "d1" }, name: "OBJECT", type: "json" }],
      })
    );
  });
});
