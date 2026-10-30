import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";

test("opposite fragment proposals remain unresolved without mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-fragment-conflicts-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    const batch: any = {
      path: "/fake",
      sessionId: "s",
      leaf: "b",
      items: [
        {
          id: "a",
          role: "user",
          text: "Network mode is enabled. " + "a ".repeat(7000),
        },
        {
          id: "b",
          role: "user",
          text: "Network mode is disabled. " + "b ".repeat(7000),
        },
      ],
      more: false,
      acknowledge: () => {
        throw new Error("must not acknowledge");
      },
    };
    let assessments = 0;
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
            return { verdict: "supported", reason: "Claim." };
          }
          const item = data.session.find((s: any) =>
            /Network mode is (?:enabled|disabled)/.test(s.text),
          );
          if (!item)
            return {
              action: "no_change",
              reason: "Reviewed.",
              evidenceSufficient: true,
            };
          const content = item.text.includes("enabled")
            ? "Network mode is enabled."
            : "Network mode is disabled.";
          return {
            action: "add",
            category: "knowledge",
            content,
            reason: "Claim.",
            citation: { kind: "session", id: item.id, quote: item.text },
          };
        },
      },
    });
    assert.equal((await reviewer.review({ batch })).status, "unresolved");
    assert.equal(assessments, 0);
    assert.equal((await store.list()).memories.length, 0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("compatible similar fragment proposals do not block the first validated add", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-fragment-compatible-"));
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await store.init();
    const batch: any = {
      path: "/fake",
      sessionId: "s",
      leaf: "b",
      items: [
        {
          id: "a",
          role: "user",
          text: "Storage is persistent. " + "a ".repeat(7000),
        },
        {
          id: "b",
          role: "user",
          text: "Storage was persistent. " + "b ".repeat(7000),
        },
      ],
      more: false,
      acknowledge: () => {
        throw new Error("must not acknowledge");
      },
    };
    const reviewer = new MemoryReviewer({
      project: root,
      store,
      contextWindow: 3000,
      validateSession: async () => {},
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) return { paths: [] };
          if (instruction.startsWith("Independently"))
            return { verdict: "supported", reason: "Direct." };
          const item = data.session.find((s: any) =>
            /Storage (?:is|was) persistent/.test(s.text),
          );
          if (!item)
            return {
              action: "no_change",
              reason: "Reviewed.",
              evidenceSufficient: true,
            };
          const content = item.text.includes("Storage is")
            ? "Storage is persistent."
            : "Storage was persistent.";
          return {
            action: "add",
            category: "knowledge",
            content,
            reason: "Claim.",
            citation: { kind: "session", id: item.id, quote: item.text },
          };
        },
      },
    });
    assert.equal((await reviewer.review({ batch })).status, "applied");
    assert.equal(
      (await store.list()).memories[0].content,
      "Storage is persistent.",
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
