import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

for (const mode of [
  "supported",
  "insufficient",
  "forged",
  "assistant",
] as const)
  test(`partial direct-user proposal ${mode} is checked across all pages`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-subfragment-"));
    const store = new MemoryManager(root, { semanticEnabled: false });
    try {
      await store.init();
      const text = "Always use TLS. " + "More context. ".repeat(2500);
      const item: any = {
        id: "u",
        role: mode === "assistant" ? "assistant" : "user",
        text,
        chunk: {
          start: 0,
          end: Buffer.byteLength(text),
          total: Buffer.byteLength(text) + 10,
        },
      };
      let ack = 0,
        assessments = 0,
        pages = 0;
      const batch: any = {
        path: "/fake",
        sessionId: "s",
        leaf: "u",
        items: [item],
        more: true,
        acknowledge: () => ack++,
      };
      const reviewer = new MemoryReviewer({
        project: root,
        store,
        contextWindow: 3000,
        validateSession: async () => {},
        model: {
          generate: async ({ instruction, data }: any) => {
            if (instruction.startsWith("Select")) return { paths: [] };
            if (instruction.startsWith("Independently")) {
              assessments++;
              assert.match(instruction, /omitted context/);
              return { verdict: "supported", reason: "The excerpt is clear." };
            }
            pages++;
            assert.ok(data.session[0].fragment);
            if (data.sessionPage === 1)
              return {
                action: "add",
                category: "practices",
                content: "Always use TLS.",
                reason: "Direct statement.",
                citation: {
                  kind: "session",
                  id: "u",
                  quote:
                    mode === "forged"
                      ? "Always use TLS."
                      : data.session[0].text,
                },
              };
            return {
              action: "no_change",
              reason: "Reviewed.",
              evidenceSufficient: mode !== "insufficient",
            };
          },
        },
      });
      const result = await reviewer.review({ batch });
      assert.ok(pages > 1);
      assert.equal(
        result.status,
        mode === "supported" ? "applied" : "unresolved",
        JSON.stringify(result),
      );
      assert.equal(assessments, mode === "supported" ? 1 : 0);
      assert.equal(ack, 0);
      assert.equal(
        (await store.list()).memories.length,
        mode === "supported" ? 1 : 0,
      );
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
