import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

for (const action of ["no_change", "add"] as const)
  test(`source message chunk supports ${action} with independent assessment`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-session-chunk-"));
    const store = new MemoryManager(root, { semanticEnabled: false });
    try {
      await store.init();
      let ack = 0,
        decisions = 0;
      const batch: any = {
        path: "/fake",
        sessionId: "s",
        leaf: "u",
        items: [
          {
            id: "u",
            role: "user",
            text: "Always use TLS",
            chunk: { start: 0, end: 14, total: 40 },
          },
        ],
        more: true,
        acknowledge: () => ack++,
      };
      const reviewer = new MemoryReviewer({
        project: root,
        store,
        validateSession: async () => {},
        model: {
          generate: async ({ instruction, data }: any) => {
            if (instruction.startsWith("Select")) return { paths: [] };
            if (instruction.startsWith("Independently")) {
              assert.match(
                instruction,
                /surrounding message text may be omitted/,
              );
              return {
                verdict: "supported",
                reason: "The excerpt states the instruction directly.",
              };
            }
            decisions++;
            assert.equal(data.sessionFragmented, true);
            assert.deepEqual(data.session[0].chunk, {
              start: 0,
              end: 14,
              total: 40,
            });
            return action === "no_change"
              ? {
                  action,
                  reason: "Reviewed this chunk.",
                  evidenceSufficient: true,
                }
              : {
                  action,
                  category: "practices",
                  content: "Always use TLS",
                  citation: {
                    kind: "session",
                    id: "u",
                    quote: "Always use TLS",
                  },
                  reason: "Claimed instruction.",
                };
          },
        },
      });
      const result = await reviewer.review({ batch });
      assert.equal(decisions, 1);
      assert.equal(
        result.status,
        action === "no_change" ? "unchanged" : "applied",
      );
      assert.equal(ack, action === "no_change" ? 1 : 0);
      assert.equal(
        (await store.list()).memories.length,
        action === "add" ? 1 : 0,
      );
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
