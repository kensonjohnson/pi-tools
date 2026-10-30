import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

for (const insufficient of [false, true])
  test(`oversized memory is reviewed without ${insufficient ? "acknowledging an insufficient fragment" : "losing fragments"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-memory-pages-"));
    const store = new MemoryManager(root, { semanticEnabled: false });
    try {
      await store.init();
      const content = "Long fact 😀 ".repeat(3000).trim();
      await store.remember("knowledge", content);
      let ack = 0;
      const batch: any = {
        path: "/fake",
        sessionId: "s",
        leaf: "u",
        items: [{ id: "u", role: "user", text: "Review the record." }],
        more: false,
        acknowledge: () => ack++,
      };
      const selected: string[] = [],
        reviewed: string[] = [];
      const reviewer = new MemoryReviewer({
        project: root,
        store,
        contextWindow: 3000,
        validateSession: async () => {},
        model: {
          generate: async ({ instruction, data }: any) => {
            const record = data.memories[0];
            assert.ok(record.fragment);
            assert.equal(record.content.isWellFormed(), true);
            if (instruction.startsWith("Select")) {
              selected.push(record.content);
              return { paths: [] };
            }
            assert.equal(data.memoryFragmented, true);
            reviewed.push(record.content);
            return {
              action: "no_change",
              reason: "Reviewed fragment.",
              evidenceSufficient: !insufficient || reviewed.length !== 1,
            };
          },
        },
      });
      const result = await reviewer.review({ batch });
      assert.equal(selected.join(""), content);
      assert.equal(reviewed.join(""), content);
      assert.equal(result.acknowledged, !insufficient);
      assert.equal(ack, insufficient ? 0 : 1);
      assert.equal(result.status, insufficient ? "unresolved" : "unchanged");
      assert.equal((await store.list()).memories[0].content, content);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
