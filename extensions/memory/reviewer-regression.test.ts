import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import type { ReviewBatch } from "./session-review.ts";

const batch = (ack: () => void): ReviewBatch => ({
  path: "/fake",
  sessionId: "s",
  leaf: "leaf",
  items: [{ id: "u", role: "user", text: "Review these project facts." }],
  more: false,
  acknowledge: ack,
});
const fakeValidate = async () => {};
test("incremental review of 201 memories requires each snapshot-bound page before acknowledgement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines = Array.from(
    { length: 201 },
    (_, i) =>
      JSON.stringify({ id: String(i), content: `Fact ${i}`, created: "2024" }) +
      "\n",
  ).join("");
  const state = {
    snapshots: {
      knowledge: { contents: lines, mode: 0o600 },
      practices: { contents: "", mode: 0o600 },
      decisions: { contents: "", mode: 0o600 },
    },
  };
  const store: any = { captureAddPrecondition: async () => state };
  let reviewed = 0;
  const model: any = {
    generate: async ({ instruction, data }: any) => {
      if (instruction.startsWith("Select")) return { paths: [] };
      if (instruction.includes("Independently review duplicate"))
        return {
          action: "no_change",
          reason: "Reviewed.",
          evidenceSufficient: true,
        };
      if (!data.comparisonOnly) reviewed += data.memories.length;
      return {
        action: "no_change",
        evidenceSufficient: true,
        reason: "Session reviewed.",
      };
    },
  };
  const reviewer = new MemoryReviewer({
    project: root,
    store,
    model,
    contextWindow: 2500,
    validateSession: fakeValidate,
  });
  let ack = 0;
  const b = batch(() => ack++);
  let offset: number | undefined;
  let snapshot: string | undefined;
  let calls = 0;
  do {
    const result = await reviewer.review({
      batch: b,
      fullOffset: offset,
      fullSnapshot: snapshot,
    });
    calls++;
    if (result.nextOffset !== undefined) assert.equal(ack, 0);
    offset = result.nextOffset;
    snapshot = result.fullSnapshot;
  } while (offset !== undefined);
  assert.ok(calls > 1);
  assert.equal(reviewed, 201);
  assert.equal(ack, 1);
  await assert.rejects(
    reviewer.review({ batch: b, fullOffset: 50, fullSnapshot: snapshot }),
    /snapshot changed|in order/,
  );
});

test("source changes or cancellation during mutation produce explicit uncertainty and no acknowledgement", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-uncertain-"));
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    await writeFile(join(cwd, "fact.txt"), "Queue uses disk.\n");
    let ack = 0;
    const controller = new AbortController();
    const wrapped = {
      captureAddPrecondition: store.captureAddPrecondition.bind(store),
      update: store.update.bind(store),
      forget: store.forget.bind(store),
      move: store.move.bind(store),
      remember: async (...args: Parameters<MemoryManager["remember"]>) => {
        const result = await store.remember(...args);
        await writeFile(join(cwd, "fact.txt"), "Queue uses memory.\n");
        controller.abort();
        return result;
      },
    };
    const model: any = {
      generate: async ({ instruction, data }: any) =>
        instruction.startsWith("Select")
          ? { paths: ["fact.txt"] }
          : instruction.includes("Independently review duplicate")
            ? {
                action: "no_change",
                reason: "No duplicates.",
                evidenceSufficient: true,
              }
            : instruction.startsWith("Independently")
              ? { verdict: "supported", reason: "Full file supports it." }
              : {
                  action: "add",
                  category: "knowledge",
                  content: "The queue uses disk.",
                  reason: "The configuration specifies disk.",
                  citation: {
                    kind: "file",
                    id: data.files[0].id,
                    quote: "Queue uses disk.",
                  },
                },
    };
    const reviewer = new MemoryReviewer({
      project: cwd,
      store: wrapped,
      model,
      validateSession: fakeValidate,
    });
    const result = await reviewer.review({
      batch: batch(() => ack++),
      signal: controller.signal,
    });
    assert.equal(result.status, "uncertain");
    assert.match(result.detail, /do not retry automatically/);
    assert.equal(ack, 0);
    assert.equal((await store.list()).memories.length, 1);
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
