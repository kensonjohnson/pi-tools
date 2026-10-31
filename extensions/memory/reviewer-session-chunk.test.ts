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
            if (instruction.includes("Independently review duplicate"))
              return {
                action: "no_change",
                reason: "Reviewed.",
                evidenceSufficient: true,
              };
            if (instruction.startsWith("Independently compare"))
              return {
                verdict: "no_conflict",
                reason: "No contrary evidence.",
              };
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
            if (instruction.includes("Independently review duplicate"))
              return {
                action: "no_change",
                reason: "Reviewed.",
                evidenceSufficient: true,
              };
            if (instruction.startsWith("Independently compare"))
              return {
                verdict: "no_conflict",
                reason: "No contrary evidence.",
              };
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
          if (instruction.includes("Independently review duplicate"))
            return {
              action: "no_change",
              reason: "Reviewed.",
              evidenceSufficient: true,
            };
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
