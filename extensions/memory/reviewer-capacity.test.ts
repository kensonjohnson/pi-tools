import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

async function fixture(
  fn: (cwd: string, store: MemoryManager) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "review-capacity-"));
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    await fn(cwd, store);
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("reviews more than 50 records and captures more than eight requests", () =>
  fixture(async (cwd, store) => {
    for (let i = 0; i < 55; i++)
      await store.remember("knowledge", `Distinct record ${i}.`);
    const paths = Array.from({ length: 12 }, (_, i) => `source-${i}.txt`);
    for (const path of paths) await writeFile(join(cwd, path), "Evidence.");
    let reviewed = 0,
      captured = 0;
    const reviewer = new MemoryReviewer({
      project: cwd,
      store,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) {
            reviewed = data.memories.length;
            return { paths };
          }
          captured = data.files.length;
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(reviewed, 55);
    assert.equal(captured, 12);
    assert.equal(result.nextOffset, undefined);
  }));

test("capacity pages retain whole records and oversized records remain unchanged", () =>
  fixture(async (cwd, store) => {
    await store.remember("knowledge", "First record " + "a".repeat(800));
    await store.remember("knowledge", "Second record " + "b".repeat(800));
    const reviewer = new MemoryReviewer({
      project: cwd,
      store,
      contextWindow: 1100,
      model: {
        generate: async ({ instruction }: any) =>
          instruction.startsWith("Select")
            ? { paths: [] }
            : {
                action: "no_change",
                reason: "Reviewed.",
                evidenceSufficient: true,
              },
      },
    });
    const first = await reviewer.review();
    assert.equal(first.nextOffset, 1);
    const second = await reviewer.review({
      fullOffset: first.nextOffset,
      fullSnapshot: first.fullSnapshot,
    });
    assert.equal(second.nextOffset, undefined);
    const huge = (
      await store.remember("knowledge", "Huge fact " + "z".repeat(10000))
    ).memory;
    let sawTruncated = false;
    const limited = new MemoryReviewer({
      project: cwd,
      store,
      contextWindow: 1100,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) {
            if (data.truncatedMemoryIds.includes(huge.id)) {
              sawTruncated = true;
              assert.ok(data.memories[0].content.length < huge.content.length);
            }
            return { paths: [] };
          }
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    let page = await limited.review();
    while (page.nextOffset !== undefined)
      page = await limited.review({
        fullOffset: page.nextOffset,
        fullSnapshot: page.fullSnapshot,
      });
    assert.equal(sawTruncated, true);
    assert.equal(page.audit?.coverage, "insufficient");
    assert.equal((await store.list()).memories.length, 3);
  }));

test("accepts long proposed content and reasons with complete cited evidence", () =>
  fixture(async (cwd, store) => {
    const content = "Long fact " + "x".repeat(5000);
    await writeFile(join(cwd, "fact.txt"), content);
    const reviewer = new MemoryReviewer({
      project: cwd,
      store,
      model: {
        generate: async ({ instruction, data }: any) =>
          instruction.startsWith("Select")
            ? { paths: ["fact.txt"] }
            : instruction.startsWith("Independently")
              ? { verdict: "supported", reason: "r".repeat(3000) }
              : {
                  action: "add",
                  category: "knowledge",
                  content,
                  reason: "r".repeat(3000),
                  citation: {
                    kind: "file",
                    id: data.files[0].id,
                    quote: content,
                  },
                },
      },
    });
    assert.equal((await reviewer.review()).status, "applied");
    assert.equal((await store.list()).memories[0].content, content);
  }));
