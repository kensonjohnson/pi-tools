import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { createPiMemoryReviewer, MemoryReviewer } from "./reviewer.ts";
import { ReviewerContextOverflowError } from "./reviewer-model.ts";

function snapshot(count: number) {
  return {
    snapshots: {
      knowledge: {
        contents:
          Array.from({ length: count }, (_, i) =>
            JSON.stringify({
              id: `m${i}`,
              content: `Record ${i} ` + "x".repeat(180),
              created: "2025",
            }),
          ).join("\n") + "\n",
        mode: 0o600,
      },
      practices: { contents: "", mode: 0o600 },
      decisions: { contents: "", mode: 0o600 },
    },
  };
}
function fakeStore(saved: any) {
  return {
    captureAddPrecondition: async () => saved,
    remember: async () => {
      throw new Error("unexpected mutation");
    },
    update: async () => {
      throw new Error("unexpected mutation");
    },
    forget: async () => {
      throw new Error("unexpected mutation");
    },
    move: async () => {
      throw new Error("unexpected mutation");
    },
  } as any;
}
const tokens = (text: string) =>
  estimateTokens({ role: "user", content: text, timestamp: 0 });

for (const underestimate of [false, true])
  test(`configured 3000/500 model ${underestimate ? "adaptively repacks underestimated requests" : "reserves output capacity"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-overflow-"));
    try {
      const saved = snapshot(80),
        requests: Array<{ input: number; rejected: boolean }> = [];
      const registry: any = {
        find: () => ({
          provider: "p",
          id: "m",
          input: ["text"],
          contextWindow: 3000,
          maxTokens: 500,
        }),
        getApiKeyAndHeaders: async () => ({ ok: true }),
        complete: async (_model: any, context: any, options: any) => {
          assert.equal(Object.hasOwn(options, "maxTokens"), false);
          const prompt = context.systemPrompt + context.messages[0].content;
          const input = underestimate
            ? Math.ceil(prompt.length / 3)
            : tokens(prompt);
          const rejected = input + 500 > 3000;
          requests.push({ input, rejected });
          if (rejected)
            return {
              stopReason: "error",
              errorMessage: '{"error":{"code":"context_length_exceeded"}}',
              content: [],
            };
          const selecting = context.systemPrompt.includes(
            "Select evidence requests",
          );
          return {
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: selecting
                  ? '{"paths":[]}'
                  : '{"action":"no_change","reason":"Reviewed.","evidenceSufficient":true}',
              },
            ],
          };
        },
      };
      const reviewer = createPiMemoryReviewer({
        project: root,
        store: fakeStore(saved),
        ctx: { modelRegistry: registry },
        configuredModel: "p/m",
      });
      const first = await reviewer.review();
      assert.equal(first.status, "unchanged", JSON.stringify(first));
      assert.ok(first.nextOffset);
      const rejectedBefore = requests.filter((r) => r.rejected).length;
      if (underestimate) assert.ok(rejectedBefore > 0);
      else assert.equal(rejectedBefore, 0);
      const resumed = await reviewer.review({
        fullOffset: first.nextOffset,
        fullSnapshot: first.fullSnapshot,
      });
      assert.equal(resumed.status, "unchanged", JSON.stringify(resumed));
      assert.equal(requests.filter((r) => r.rejected).length, rejectedBefore);
      if (underestimate) {
        const firstReject = requests.findIndex((r) => r.rejected);
        assert.ok(
          requests
            .slice(firstReject + 1)
            .some((r) => !r.rejected && r.input < requests[firstReject].input),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("a decision-stage context overflow repacks before any mutation and preserves page order", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-decision-overflow-"));
  try {
    const sizes: number[] = [];
    const reviewer = new MemoryReviewer({
      project: root,
      store: fakeStore(snapshot(80)),
      contextWindow: 3000,
      maxOutputTokens: 500,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) return { paths: [] };
          const size = tokens(JSON.stringify(data));
          sizes.push(size);
          if (size > 1000) throw new ReviewerContextOverflowError();
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    const first = await reviewer.review();
    assert.equal(first.status, "unchanged", JSON.stringify(first));
    assert.ok(first.nextOffset);
    assert.ok(sizes.some((n) => n > 1000));
    assert.ok(sizes.at(-1)! <= 1000);
    const next = await reviewer.review({
      fullOffset: first.nextOffset,
      fullSnapshot: first.fullSnapshot,
    });
    assert.equal(next.status, "unchanged");
    assert.equal(next.audit?.pageOffset, first.nextOffset);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only typed model inference overflows retry; other errors and store failures do not", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-overflow-safe-"));
  try {
    let calls = 0;
    const saved = snapshot(1);
    const generic = new MemoryReviewer({
      project: root,
      store: fakeStore(saved),
      contextWindow: 3000,
      model: {
        generate: async () => {
          calls++;
          throw new Error("generic provider failure");
        },
      },
    });
    await assert.rejects(generic.review(), /generic provider failure/);
    assert.equal(calls, 1);
    let captures = 0;
    const storeFailure = new MemoryReviewer({
      project: root,
      store: {
        ...fakeStore(saved),
        captureAddPrecondition: async () => {
          captures++;
          throw new ReviewerContextOverflowError();
        },
      },
      contextWindow: 3000,
      model: { generate: async () => ({ paths: [] }) },
    });
    await assert.rejects(storeFailure.review(), ReviewerContextOverflowError);
    assert.equal(captures, 1);
    const controller = new AbortController();
    let abortedCalls = 0;
    const aborted = new MemoryReviewer({
      project: root,
      store: fakeStore(saved),
      contextWindow: 3000,
      model: {
        generate: async () => {
          abortedCalls++;
          controller.abort();
          throw new ReviewerContextOverflowError();
        },
      },
    });
    await assert.rejects(aborted.review({ signal: controller.signal }));
    assert.equal(abortedCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
