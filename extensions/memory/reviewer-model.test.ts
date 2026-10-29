import { test } from "node:test";
import assert from "node:assert/strict";
import { PiReviewerModel } from "./reviewer-model.ts";

test("review model requires explicit available authenticated text chat model and never falls back", async () => {
  let calls = 0;
  const model = { provider: "p", id: "m", input: ["text"] };
  const registry: any = {
    find: (p: string, id: string) =>
      p === "p" && id === "m" ? model : undefined,
    getApiKeyAndHeaders: async () => ({ ok: true }),
    complete: async (_model: unknown, context: any) => {
      calls++;
      assert.equal(context.tools, undefined);
      return {
        stopReason: "stop",
        content: [{ type: "text", text: '{"ok":true}' }],
      };
    },
  };
  await assert.rejects(
    new PiReviewerModel(registry, "").generate({
      instruction: "test",
      data: {},
    }),
    /explicitly/,
  );
  await assert.rejects(
    new PiReviewerModel(registry, "inherit").generate({
      instruction: "test",
      data: {},
    }),
    /explicitly/,
  );
  await assert.rejects(
    new PiReviewerModel(registry, "missing/model").generate({
      instruction: "test",
      data: {},
    }),
    /unavailable/,
  );
  registry.getApiKeyAndHeaders = async () => ({ ok: false, error: "missing" });
  await assert.rejects(
    new PiReviewerModel(registry, "p/m").generate({
      instruction: "test",
      data: {},
    }),
    /authentication/,
  );
  registry.getApiKeyAndHeaders = async () => ({ ok: true });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new PiReviewerModel(registry, "p/m").generate({
      instruction: "test",
      data: {},
      signal: controller.signal,
    }),
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await new PiReviewerModel(registry, "p/m").generate({
      instruction: "test",
      data: {},
    }),
    { ok: true },
  );
  assert.equal(calls, 1);
  registry.complete = async () => ({
    stopReason: "stop",
    content: [{ type: "text", text: "bad" }],
  });
  await assert.rejects(
    new PiReviewerModel(registry, "p/m").generate({
      instruction: "test",
      data: {},
    }),
    /malformed JSON/,
  );
});
