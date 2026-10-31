import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PiReviewerModel,
  ReviewerContextOverflowError,
} from "./reviewer-model.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { MemoryManager } from "./core.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const response = (text: string) => ({
  stopReason: "stop",
  content: [{ type: "text", text }],
});
function fixture(original: string, repaired: string, overrides: any = {}) {
  const contexts: any[] = [],
    options: any[] = [];
  const registry: any = {
    find: () => ({
      input: ["text"],
      contextWindow: 8192,
      maxTokens: 2048,
      ...overrides.model,
    }),
    getApiKeyAndHeaders: async () => ({ ok: true }),
    complete: async (_model: unknown, context: any, option: any) => {
      contexts.push(context);
      options.push(option);
      if (contexts.length === 1) return response(original);
      if (overrides.repair) return overrides.repair();
      return response(repaired);
    },
  };
  return {
    contexts,
    options,
    registry,
    generate: (allowRepair = true, signal?: AbortSignal) =>
      new PiReviewerModel(registry, "p/m").generate({
        instruction: "decide",
        data: { secret: "original-context-secret" },
        allowRepair,
        signal,
      }),
  };
}

for (const original of [
  '{"action":"no_change","evidenceSufficient":false,}',
  '```json\n{"action":"no_change","evidenceSufficient":false,}\n```',
]) {
  test("syntax-only repair accepts a trailing comma without changing values", async () => {
    const f = fixture(
      original,
      '{"action":"no_change","evidenceSufficient":false}',
    );
    assert.deepEqual(await f.generate(), {
      action: "no_change",
      evidenceSufficient: false,
    });
    assert.equal(f.contexts.length, 2);
    assert.match(f.contexts[1].systemPrompt, /untrusted data/);
    assert.doesNotMatch(
      f.contexts[1].messages[0].content,
      /original-context-secret/,
    );
    assert.equal(
      JSON.parse(f.contexts[1].messages[0].content).malformed,
      original,
    );
    assert.ok(f.options[1].maxTokens <= 2048);
  });
}

test("repair preserves quoted escapes and embedded whitespace exactly", async () => {
  const value = 'quoted "value" with \\ path,\n  spaces\tand a literal \\n';
  const original = `{ "value" : ${JSON.stringify(value)}, }`;
  const valid = fixture(original, JSON.stringify({ value }));
  assert.deepEqual(await valid.generate(), { value });
  const changed = fixture(
    original,
    JSON.stringify({ value: value.replace("  spaces", " spaces") }),
  );
  await assert.rejects(changed.generate(), /malformed JSON/);
  assert.equal(changed.contexts.length, 2);
});

test("repair refuses hallucinated fields, changed values, duplicate removal and truncated completions", async () => {
  for (const [original, repaired] of [
    ['{"action":"update","id":"a",}', '{"action":"update","id":"b"}'],
    ['{"action":"update",}', '{"action":"update","id":"a"}'],
    ['{"action":"update","id":"a"', '{"action":"update","id":"a"}'],
    ['{"action":"update","id":"a","id":"b"}', '{"action":"update","id":"b"}'],
    ['{"value":1 2,}', '{"value":12}'],
    ['{"value":tru e,}', '{"value":true}'],
    ['{"value":true,}', '{"value":true,,}'],
  ]) {
    const f = fixture(original, repaired);
    await assert.rejects(f.generate(), /malformed JSON/);
    assert.equal(f.contexts.length, 2);
  }
});

test("repair remains disabled after writes and when capacity is unknown or insufficient", async () => {
  for (const [allow, model] of [
    [false, {}],
    [true, { contextWindow: undefined }],
    [true, { maxTokens: undefined }],
    [true, { contextWindow: 10 }],
    [true, { maxTokens: 0 }],
  ] as const) {
    const f = fixture('{"value":true,}', '{"value":true}', { model });
    await assert.rejects(f.generate(allow), /malformed JSON/);
    assert.equal(f.contexts.length, 1);
  }
});

test("repair errors are bounded, typed where appropriate, and contain no provider or response secrets", async () => {
  const f = fixture('{"secret":"original-response-secret",}', "", {
    repair: () => {
      throw new Error("secret provider detail");
    },
  });
  await assert.rejects(f.generate(), (error: Error) => {
    assert.match(error.message, /repair failed/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  assert.equal(f.contexts.length, 2);
  const overflow = fixture('{"ok":true,}', "", {
    repair: () => {
      throw new Error("context_length_exceeded");
    },
  });
  await assert.rejects(overflow.generate(), ReviewerContextOverflowError);
  const incomplete = fixture('{"ok":true,}', "", {
    repair: () => ({
      stopReason: "length",
      errorMessage: "secret provider detail",
      content: [],
    }),
  });
  await assert.rejects(incomplete.generate(), (error: Error) => {
    assert.match(error.message, /repair did not complete/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test("repaired JSON still undergoes reviewer schema validation before a write", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-repair-schema-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    await store.remember("knowledge", "Alpha old.");
    let calls = 0,
      writes = 0;
    const registry: any = {
      find: () => ({ input: ["text"], contextWindow: 8192, maxTokens: 2048 }),
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete: async () =>
        response(
          ++calls === 1
            ? '{"paths":[]}'
            : calls === 2
              ? '{"action":"update",}'
              : calls === 3
                ? '{"action":"update"}'
                : '{"action":"no_change","reason":"Reviewed.","evidenceSufficient":true}',
        ),
    };
    const update = store.update.bind(store);
    store.update = async (...args: Parameters<typeof store.update>) => {
      writes++;
      return update(...args);
    };
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: new PiReviewerModel(registry, "p/m"),
    });
    const result = await reviewer.review();
    assert.equal(result.status, "unresolved");
    assert.match(result.detail, /malformed/i);
    assert.equal(result.acknowledged, false);
    assert.equal(calls, 4);
    assert.equal(writes, 0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a reviewer disables repair for later assessments after its first write", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-repair-gate-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    const ids = [
      (await store.remember("knowledge", "Alpha old.")).memory.id,
      (await store.remember("knowledge", "Beta old.")).memory.id,
    ];
    await writeFile(
      join(root, "source.txt"),
      "Alpha current.\n\nBeta current.\n",
    );
    const gates: boolean[] = [];
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      model: {
        generate: async ({ instruction, data, allowRepair }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: ["source.txt"] };
          if (instruction.includes("Independently review duplicate"))
            return {
              action: "no_change",
              reason: "No duplicates.",
              evidenceSufficient: true,
            };
          if (instruction.startsWith("Independently classify"))
            return {
              authority: "fact",
              noInstructionOrPreference: true,
              reason: "Descriptive fact.",
            };
          if (instruction.startsWith("Independently")) {
            gates.push(allowRepair);
            return { verdict: "supported", reason: "Source." };
          }
          return {
            proposals: ids.map((id, i) => ({
              action: "update",
              id,
              content: `${i ? "Beta" : "Alpha"} current.`,
              targetAuthority: "fact",
              reason: "Source.",
              citation: {
                kind: "file",
                id: data.files[0].id,
                quote: `${i ? "Beta" : "Alpha"} current.`,
              },
            })),
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(result.status, "applied");
    assert.deepEqual(gates, [true, false]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("initial provider exceptions with quoted and whitespace secrets are fully sanitized", async () => {
  for (const secret of [
    'token="secret-credential"\\n  private',
    'token="secret-credential"\n\tprivate',
  ]) {
    const f = fixture('{"ok":true,}', '{"ok":true}');
    let calls = 0;
    f.registry.complete = async () => {
      calls++;
      throw new Error(secret);
    };
    await assert.rejects(f.generate(), (error: Error) => {
      assert.equal(error.message, "review model provider request failed");
      assert.doesNotMatch(
        `${error.stack} ${JSON.stringify(error)}`,
        /secret|credential|private/,
      );
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("provider errors and cancellation do not trigger repair", async () => {
  const f = fixture('{"ok":true,}', '{"ok":true}');
  let providerCalls = 0;
  f.registry.complete = async () => {
    providerCalls++;
    throw new Error(
      'provider failed with token "secret-credential"\\n  private detail',
    );
  };
  await assert.rejects(f.generate(), (error: Error) => {
    assert.equal(error.message, "review model provider request failed");
    assert.doesNotMatch(error.message, /secret|private|credential/);
    return true;
  });
  assert.equal(f.contexts.length, 0);
  assert.equal(providerCalls, 1);
  const controller = new AbortController();
  const g = fixture('{"ok":true,}', '{"ok":true}', {
    repair: () => {
      controller.abort();
      return response('{"ok":true}');
    },
  });
  await assert.rejects(g.generate(true, controller.signal), /abort/i);
  assert.equal(g.contexts.length, 2);
});
