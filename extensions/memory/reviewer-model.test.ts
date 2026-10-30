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

test("review model does not impose its own input or output caps", async () => {
  let options: any;
  const long = "x".repeat(600_000);
  const registry: any = {
    find: () => ({ input: ["text"] }),
    getApiKeyAndHeaders: async () => ({ ok: true }),
    complete: async (_model: unknown, context: any, requestOptions: any) => {
      options = requestOptions;
      assert.ok(context.messages[0].content.includes(long));
      return {
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify({ content: long }) }],
      };
    },
  };
  const result = await new PiReviewerModel(registry, "p/m").generate({
    instruction: "test",
    data: { content: long },
  });
  assert.deepEqual(result, { content: long });
  assert.equal(Object.hasOwn(options, "maxTokens"), false);
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
    'Here is the result: {"ok":true} Thanks.',
    'In 2024 this is true and null: {"ok":true} 42',
    '{"ok":true,"left":{"x":1},"right":{"x":2}}',
    'Result:\n```javascript\n{"ok":true}\n```\nDone.',
    'Ignore the quoted "{not a candidate}". {"ok":true}',
    '{"ok":true, "nested":{"x":"} [ \\""}}',
  ]) {
    const result = (await generate()) as any;
    assert.equal(result.ok, true);
  }
  text = 'Prose\n```json\n[1, {"x": "} ["}]\n```\nEnd';
  assert.deepEqual(await generate(), [1, { x: "} [" }]);
  text = "Prose\n```json\nfalse\n```\nEnd";
  assert.equal(await generate(), false);
  text = '"a bare JSON string"';
  assert.equal(await generate(), "a bare JSON string");
  const secret = "secret-provider-content";
  for (text of [
    `Here is JSON: {"secret":"${secret}"} and {"other":true}`,
    '```json\n{"ok":true}\n```\n```json\n{"ok":false}\n```',
    '```json\n{"ok":true} {"ok":false}\n```',
    '```json\n{"ok":\n```',
    '```json\n{"ok":true}',
    '{"ok":',
    '{"outer": {"ok":true} invalid}',
    '{"ok":true,"ok":false}',
    '{"ok":true,"nested":[{"x":1,"x":2}]}',
    '{"ok":true,"a":1,"\\u0061":2}',
    'Result: {"ok":true,"ok":false}',
    '```json\n{"ok":true,"nested":{"x":1,"x":2}}\n```',
    '{"ok":true,"secret-provider-content":1,"secret-provider-content":2}',
    "```json\n".repeat(3000),
    'Result: {"ok":true} {"broken":',
    'Result: {"ok":true} [broken]',
    'Result: {"ok":true} and "unterminated {',
    '```json\n{"ok":true}\n```\n{"ok":false}',
    `not JSON ${secret}`,
    'before ```json\n{"ok":true}\n```',
    '```json\n{"ok":true}\n```\n```json\nnull\n```',
    "",
  ]) {
    await assert.rejects(generate(), (error: Error) => {
      assert.match(error.message, /malformed JSON/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.ok(error.message.length < 150);
      return true;
    });
  }
  text = "x".repeat(64 * 1024 + 1);
  await assert.rejects(generate(), /malformed JSON/);
  registry.complete = async () => ({
    stopReason: "stop",
    content: [
      { type: "text", text: "x".repeat(40_000) },
      { type: "text", text: "x".repeat(40_000) },
    ],
  });
  await assert.rejects(generate(), /malformed JSON/);
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
