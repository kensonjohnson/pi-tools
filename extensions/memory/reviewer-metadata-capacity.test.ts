import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

test("oversized search query metadata is disclosed in all context-fitting pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-metadata-pages-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    await writeFile(join(root, "source.txt"), "other");
    const query = "long-query".repeat(4000);
    const chunks: string[] = [];
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      contextWindow: 3000,
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: [], search: [query] };
          assert.equal(data.metadataFragmented, true);
          assert.ok(JSON.stringify(data).length < 12000);
          chunks.push(data.searches[0].query);
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    const result = await reviewer.review();
    assert.equal(result.status, "unchanged");
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), query);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
