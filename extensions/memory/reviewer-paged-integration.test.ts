import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

test("reviewer traverses all discovery and search pages and presents every match", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-pages-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    const count = 4105;
    for (let start = 0; start < count; start += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, count - start) }, (_, n) => {
          const i = start + n;
          return writeFile(
            join(root, `source-${String(i).padStart(4, "0")}.txt`),
            i >= count - 40 ? "needle " + "x".repeat(1000) : "other",
          );
        }),
      );
    }
    const inventory = new Set<string>();
    const matches = new Set<string>();
    let pages = 0;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      contextWindow: 4000,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) {
            for (const path of data.repositoryPaths) inventory.add(path);
            return { paths: [], search: ["needle"] };
          }
          pages++;
          for (const file of data.files) matches.add(file.path);
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(inventory.size, count);
    assert.equal(matches.size, 40);
    assert.ok(pages > 1);
    assert.equal(result.status, "unchanged");
    assert.equal(result.audit?.coverage, "limited");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
