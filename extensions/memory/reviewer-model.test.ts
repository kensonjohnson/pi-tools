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

test("review model accepts exactly one bare or fenced JSON value", async () => {
  let text = "";
  const registry: any = {
    find: () => ({ input: ["text"] }),
    getApiKeyAndHeaders: async () => ({ ok: true }),
    complete: async () => ({
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "ignored" },
        { type: "text", text },
      ],
    }),
  };
  const generate = () =>
    new PiReviewerModel(registry, "p/m").generate({
      instruction: "test",
      data: {},
    });
  for (text of [
    ' {"ok":true} ',
    '```json\n{"ok":true}\n```',
    '```JSON\r\n{"ok":true}\r\n```',
    '```\n{"ok":true}\n```',
  ]) {
    assert.deepEqual(await generate(), { ok: true });
  }
  const secret = "secret-provider-content";
  for (text of [
    `Here is JSON: {"secret":"${secret}"}`,
    '```json\n{"ok":true}\n```\nExtra prose',
    '```json\n{"ok":true}\n```\n```json\n{"ok":false}\n```',
    '```json\n{"ok":true} {"ok":false}\n```',
    '```json\n{"ok":\n```',
    '```json\n{"ok":true}',
    '{"ok":',
    '```javascript\n{"ok":true}\n```',
    `not JSON ${secret}`,
    "",
  ]) {
    await assert.rejects(generate(), (error: Error) => {
      assert.match(error.message, /malformed JSON/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.ok(error.message.length < 150);
      return true;
    });
  }
});

test("review model rejects incomplete and failed responses without provider details", async () => {
  let stopReason = "length";
  const registry: any = {
    find: () => ({ input: ["text"] }),
    getApiKeyAndHeaders: async () => ({ ok: true }),
    complete: async () => ({
      stopReason,
      errorMessage: "secret provider detail",
      rawStopReason: "secret raw reason",
      content: [{ type: "text", text: '{"ok":true}' }],
    }),
  };
  for (stopReason of [
    "length",
    "error",
    "aborted",
    "toolUse",
    "pending",
    "deferred",
    "secret unknown reason",
  ]) {
    await assert.rejects(
      new PiReviewerModel(registry, "p/m").generate({
        instruction: "test",
        data: {},
      }),
      (error: Error) => {
        assert.match(error.message, /did not complete/);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      },
    );
  }
});
