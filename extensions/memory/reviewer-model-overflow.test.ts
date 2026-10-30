import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PiReviewerModel,
  ReviewerContextOverflowError,
} from "./reviewer-model.ts";

function fixture(complete: (...args: any[]) => Promise<any>) {
  return new PiReviewerModel(
    {
      find: () => ({ input: ["text"], contextWindow: 3000, maxTokens: 500 }),
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete,
    } as any,
    "test/model",
  );
}

test("explicit provider context errors become a sanitized typed overflow", async () => {
  for (const errorMessage of [
    '400 {"error":{"code":"context_length_exceeded","message":"private source text"}}',
    "context_length_exceeded",
    "Your input exceeds the context window of this model.",
    "prompt is too long: 2,900 tokens > 2,500 maximum",
  ]) {
    let options: any;
    const model = fixture(async (_model, _context, requestOptions) => {
      options = requestOptions;
      return { stopReason: "error", errorMessage, content: [] };
    });
    await assert.rejects(
      model.generate({ instruction: "test", data: {} }),
      (error: any) =>
        error instanceof ReviewerContextOverflowError &&
        !error.message.includes("private"),
    );
    assert.equal(Object.hasOwn(options, "maxTokens"), false);
  }
  const thrown = fixture(async () => {
    throw Object.assign(new Error("private"), {
      code: "context_length_exceeded",
      status: 400,
    });
  });
  await assert.rejects(
    thrown.generate({ instruction: "test", data: {} }),
    ReviewerContextOverflowError,
  );
});

test("ambiguous provider, length and rate-limit failures are not typed as context overflow", async () => {
  for (const response of [
    { stopReason: "error", errorMessage: "too many tokens", content: [] },
    {
      stopReason: "error",
      errorMessage: "429 rate limit: context_length_exceeded",
      content: [],
    },
    { stopReason: "error", errorMessage: "400 (no body)", content: [] },
    {
      stopReason: "error",
      errorMessage: "server error context_length_exceeded",
      content: [],
    },
    {
      stopReason: "error",
      errorMessage: '503 {"error":{"code":"context_length_exceeded"}}',
      content: [],
    },
    {
      stopReason: "error",
      errorMessage: '{"status":429,"error":{"code":"context_length_exceeded"}}',
      content: [],
    },
    {
      stopReason: "error",
      errorMessage:
        '{"error":{"code":"context_length_exceeded","message":"rate limit"}}',
      content: [],
    },
    {
      stopReason: "length",
      errorMessage: "Your input exceeds the context window of this model.",
      content: [],
    },
  ]) {
    const model = fixture(async () => response);
    await assert.rejects(
      model.generate({ instruction: "test", data: {} }),
      (error: any) =>
        error instanceof Error &&
        !(error instanceof ReviewerContextOverflowError),
    );
  }
  const rate = Object.assign(new Error("throttled"), {
    code: "context_length_exceeded",
    status: 429,
  });
  const model = fixture(async () => {
    throw rate;
  });
  await assert.rejects(
    model.generate({ instruction: "test", data: {} }),
    (error: any) =>
      error === rate && !(error instanceof ReviewerContextOverflowError),
  );
});

test("cancellation takes precedence over an overflow signal", async () => {
  const controller = new AbortController();
  const model = fixture(async () => {
    controller.abort();
    throw Object.assign(new Error("context length"), {
      code: "context_length_exceeded",
    });
  });
  await assert.rejects(
    model.generate({
      instruction: "test",
      data: {},
      signal: controller.signal,
    }),
    (error: any) => !(error instanceof ReviewerContextOverflowError),
  );
});
