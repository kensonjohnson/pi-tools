import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer as RealMemoryReviewer } from "./reviewer.ts";
const MemoryReviewer = class extends RealMemoryReviewer {
  constructor(options: any) {
    super({ ...options, validateSession: async () => {} });
  }
};
import type { ReviewBatch } from "./session-review.ts";

async function fixture(
  fn: (cwd: string, store: MemoryManager) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "memory-review-progress-"));
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    await fn(cwd, store);
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
}
function noChange(
  store: MemoryManager,
  cwd: string,
  paths: string[] = [],
  contextWindow?: number,
) {
  return new MemoryReviewer({
    project: cwd,
    store,
    contextWindow,
    model: {
      generate: async ({ instruction }) =>
        instruction.startsWith("Select")
          ? { paths }
          : {
              action: "no_change",
              evidenceSufficient: true,
              reason: "Supplied evidence was reviewed.",
            },
    },
  });
}
test("full review pages bind to an unchanged snapshot", () =>
  fixture(async (cwd, store) => {
    for (let i = 0; i < 51; i++)
      await store.remember("knowledge", `Fact number ${i}.`);
    const reviewer = noChange(store, cwd, [], 1500);
    const first = await reviewer.review();
    assert.ok(first.nextOffset && first.nextOffset < 51);
    assert.ok(first.fullSnapshot);
    const second = await reviewer.review({
      fullOffset: first.nextOffset,
      fullSnapshot: first.fullSnapshot,
    });
    assert.ok(second.audit!.pageOffset! > 0);
    await store.remember("knowledge", "A new fact.");
    await assert.rejects(
      reviewer.review({
        fullOffset: first.nextOffset,
        fullSnapshot: first.fullSnapshot,
      }),
      /snapshot changed/,
    );
  }));
test("acknowledgement failure after add retries without creating duplicates", () =>
  fixture(async (cwd, store) => {
    await writeFile(join(cwd, "fact.txt"), "Database stores files.");
    let ack = 0;
    const batch: ReviewBatch = {
      path: "/session",
      sessionId: "s",
      leaf: "a",
      items: [],
      more: false,
      acknowledge() {
        if (++ack === 1) throw new Error("checkpoint changed");
      },
    };
    const reviewer = new MemoryReviewer({
      project: cwd,
      store,
      model: {
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
                ? { verdict: "supported", reason: "Source is consistent." }
                : {
                    action: "add",
                    reason: "The file records the fact.",
                    category: "knowledge",
                    content: "Database stores files.",
                    citation: {
                      kind: "file",
                      id: data.files[0].id,
                      quote: "Database stores files.",
                    },
                  },
      },
    });
    assert.equal((await reviewer.review({ batch })).status, "applied");
    assert.equal((await store.list()).memories.length, 1);
    const retry = await reviewer.review({ batch });
    assert.equal(retry.status, "unchanged");
    assert.equal(ack, 0);
    const finalPass = noChange(store, cwd, ["fact.txt"]);
    await assert.rejects(finalPass.review({ batch }), /checkpoint changed/);
    assert.equal((await finalPass.review({ batch })).acknowledged, true);
    assert.equal(ack, 2);
    assert.equal((await store.list()).memories.length, 1);
  }));
test("no-change cannot acknowledge an altered memory snapshot", () =>
  fixture(async (cwd, store) => {
    let ack = 0;
    const batch: ReviewBatch = {
      path: "/session",
      sessionId: "s",
      leaf: "a",
      items: [],
      more: false,
      acknowledge() {
        ack++;
      },
    };
    const reviewer = new MemoryReviewer({
      project: cwd,
      store,
      model: {
        generate: async ({ instruction }) => {
          if (instruction.startsWith("Select")) return { paths: [] };
          if (instruction.includes("Review factual corrections"))
            await store.remember("knowledge", "A concurrent edit.");
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    await assert.rejects(reviewer.review({ batch }), /snapshot conflict/);
    assert.equal(ack, 0);
  }));
