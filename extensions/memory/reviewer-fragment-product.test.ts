import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

test("all memory, session, metadata and evidence page combinations are reviewed before acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-fragment-product-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    await store.remember("knowledge", "memory ".repeat(2000).trim());
    await writeFile(join(root, "source.txt"), "evidence ".repeat(1600));
    const query = "absent-query".repeat(900);
    let ack = 0;
    const batch: any = {
      path: "/fake",
      sessionId: "s",
      leaf: "u",
      items: [{ id: "u", role: "user", text: "session ".repeat(2000) }],
      more: false,
      acknowledge: () => ack++,
    };
    const combinations = new Set<string>();
    let expected = 0;
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      contextWindow: 2600,
      validateSession: async () => {},
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select"))
            return { paths: ["source.txt"], search: [query] };
          expected =
            data.memoryPages *
            data.sessionPages *
            data.metadataPages *
            data.evidencePages;
          const key = [
            data.memoryPage,
            data.sessionPage,
            data.metadataPage,
            data.evidencePage,
          ].join("/");
          assert.ok(!combinations.has(key));
          combinations.add(key);
          assert.ok(JSON.stringify(data).length < 10400);
          return {
            action: "no_change",
            reason: "Reviewed page.",
            evidenceSufficient: combinations.size !== 1,
          };
        },
      },
    });
    const result = await reviewer.review({ batch });
    assert.ok(expected > 1, JSON.stringify(result));
    assert.equal(combinations.size, expected);
    assert.equal(result.status, "unresolved");
    assert.equal(ack, 0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
