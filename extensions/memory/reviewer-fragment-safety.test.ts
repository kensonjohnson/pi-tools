import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

for (const mode of ["insufficient", "mutation"] as const)
  test(`fragmented session ${mode} is never acknowledged or mutated`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-fragment-safety-"));
    const store = new MemoryManager(root, { semanticEnabled: false });
    try {
      await store.init();
      const memory = (await store.remember("knowledge", "Original fact."))
        .memory;
      let ack = 0,
        decisions = 0;
      const batch: any = {
        path: "/fake",
        sessionId: "s",
        leaf: "a",
        items: [{ id: "u", role: "user", text: "session ".repeat(5000) }],
        more: false,
        acknowledge: () => ack++,
      };
      const reviewer = new MemoryReviewer({
        project: root,
        store,
        contextWindow: 3000,
        validateSession: async () => {},
        model: {
          generate: async ({ instruction }: any) => {
            if (instruction.startsWith("Select")) return { paths: [] };
            decisions++;
            if (mode === "mutation")
              return {
                action: "remove",
                id: memory.id,
                targetAuthority: "fact",
                citation: { kind: "session", id: "u", quote: "session" },
                reason: "Claim.",
              };
            return {
              action: "no_change",
              reason: "Reviewed.",
              evidenceSufficient: decisions !== 1,
            };
          },
        },
      });
      const result = await reviewer.review({ batch });
      assert.ok(decisions > 1);
      assert.equal(result.status, "unresolved");
      if (mode === "insufficient")
        assert.deepEqual(result.audit?.gapReasons, [
          "model_insufficient",
          "fragment_insufficient",
        ]);
      assert.equal(ack, 0);
      assert.equal((await store.list()).memories[0].content, "Original fact.");
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
