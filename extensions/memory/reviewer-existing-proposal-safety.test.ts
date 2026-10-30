import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

for (const mode of ["supported", "uncertain", "forged", "changed"] as const)
  test(`existing fragment proposal ${mode} is checked before acknowledgement`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-existing-proposal-"));
    const store = new MemoryManager(root, { semanticEnabled: false });
    try {
      await store.init();
      await store.remember("practices", "Use Oak protocol.");
      let ack = 0,
        assessments = 0,
        validations = 0;
      const batch: any = {
        path: "/fake",
        sessionId: "s",
        leaf: "u",
        items: [
          {
            id: "u",
            role: "user",
            text: "Use Oak protocol.",
            chunk: { start: 0, end: 17, total: 30 },
          },
        ],
        more: false,
        acknowledge: () => ack++,
      };
      const reviewer = new MemoryReviewer({
        project: root,
        store,
        validateSession: async () => {
          if (++validations === 2 && mode === "changed")
            throw new Error("source changed");
        },
        model: {
          generate: async ({ instruction, data }: any) => {
            if (instruction.startsWith("Select")) return { paths: [] };
            if (instruction.startsWith("Independently")) {
              assessments++;
              return {
                verdict: mode === "uncertain" ? "uncertain" : "supported",
                reason: "Assessed excerpt.",
              };
            }
            return {
              action: "add",
              category: "practices",
              content: "Use Oak protocol.",
              reason: "Direct.",
              citation: {
                kind: "session",
                id: "u",
                quote: mode === "forged" ? "Oak" : data.session[0].text,
              },
            };
          },
        },
      });
      if (mode === "changed")
        await assert.rejects(reviewer.review({ batch }), /source changed/);
      else {
        const result = await reviewer.review({ batch });
        assert.equal(
          result.status,
          mode === "supported" ? "unchanged" : "unresolved",
        );
      }
      assert.equal(ack, mode === "supported" ? 1 : 0);
      assert.equal(assessments, mode === "forged" ? 0 : 1);
      assert.equal((await store.list()).memories.length, 1);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
