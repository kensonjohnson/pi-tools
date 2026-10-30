import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

test("truncated memory is marked, cannot be mutated and remains intact", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-truncated-"));
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    const original = (
      await store.remember("knowledge", "Fact " + "x".repeat(10000))
    ).memory;
    let observed = false;
    const reviewer = new MemoryReviewer({
      project: cwd,
      store,
      contextWindow: 1300,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) {
            observed = data.truncatedMemoryIds.includes(original.id);
            return { paths: [] };
          }
          return {
            action: "remove",
            id: original.id,
            targetAuthority: "fact",
            citation: { kind: "memory", id: "another", quote: "Fact" },
            reason: "Remove it.",
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(observed, true);
    assert.equal(result.status, "unresolved");
    assert.match(result.detail, /read-only/);
    assert.equal((await store.list()).memories[0].content, original.content);
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
