import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

test("oversized session messages are reviewed in disclosed pages before acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-session-pages-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    await store.remember("knowledge", "A small project fact.");
    const text = "session text 😀".repeat(3000);
    let ack = 0;
    const batch: any = {
      path: "/fake",
      sessionId: "s",
      leaf: "a",
      items: [{ id: "u", role: "user", text }],
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
          if (instruction.startsWith("Select")) {
            selected.push(data.session[0].text);
            return { paths: [] };
          }
          assert.equal(data.sessionFragmented, true);
          assert.equal(data.session[0].text.isWellFormed(), true);
          reviewed.push(data.session[0].text);
          return {
            action: "no_change",
            reason: "Reviewed.",
            evidenceSufficient: true,
          };
        },
      },
    });
    const result = await reviewer.review({ batch });
    assert.equal(selected.join(""), text);
    assert.equal(reviewed.length > 0, true, JSON.stringify(result));
    assert.equal(reviewed.join(""), text);
    assert.ok(reviewed.length > 1);
    assert.equal(result.acknowledged, true);
    assert.equal(ack, 1);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
