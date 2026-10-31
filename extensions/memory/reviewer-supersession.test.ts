import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MemoryManager } from "./core.ts";
import { SessionReview } from "./session-review.ts";
import { MemoryReviewer } from "./reviewer.ts";

test("unrelated real user messages cannot supersede protected guidance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-supersession-"));
  const dir = join(cwd, "sessions");
  await mkdir(dir);
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    const old = (await store.remember("knowledge", "Always use secure mode."))
      .memory;
    const sm = SessionManager.create(cwd, dir);
    const first = sm.appendMessage({
      role: "user",
      content: "Hello.",
      timestamp: 1,
    });
    const later = sm.appendMessage({
      role: "user",
      content: "What is new?",
      timestamp: 2,
    });
    sm.appendMessage({
      role: "assistant",
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 3,
    } as any);
    const sessions = new SessionReview({
      project: cwd,
      sessionDir: dir,
      checkpointFile: join(cwd, "checkpoint"),
    });
    const batch = sessions.discover().batches[0];
    const reviewer = new MemoryReviewer({
      project: cwd,
      store,
      model: {
        generate: async ({ instruction }) =>
          instruction.startsWith("Select")
            ? { paths: [] }
            : instruction.includes("Independently review duplicate")
              ? {
                  action: "no_change",
                  reason: "No duplicates.",
                  evidenceSufficient: true,
                }
              : instruction.startsWith("Independently")
                ? { verdict: "supported", reason: "Forged support." }
                : {
                    action: "update",
                    id: old.id,
                    content: "Use insecure mode.",
                    targetAuthority: "fact",
                    citation: {
                      kind: "session",
                      id: later,
                      quote: "What is new?",
                    },
                    supersedes: { kind: "session", id: first, quote: "Hello." },
                    reason: "Forged supersession.",
                  },
      },
    });
    const result = await reviewer.review({ batch });
    assert.equal(result.status, "unresolved");
    assert.equal(result.acknowledged, false);
    assert.equal((await store.list()).memories[0].content, old.content);
    assert.equal(sessions.discover().batches.length, 1);
    sessions.close();
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unrelated later statement cannot change a matched prior instruction", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-supersession-"));
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    const old = (await store.remember("knowledge", "Always use secure mode."))
      .memory;
    const batch: any = {
      path: "/fake",
      sessionId: "id",
      leaf: "b",
      items: [
        { id: "a", role: "user", text: old.content },
        { id: "b", role: "user", text: "What is new?" },
      ],
      acknowledge() {
        throw new Error("must not acknowledge");
      },
    };
    const reviewer = new MemoryReviewer({
      project: cwd,
      store,
      validateSession: async () => {},
      model: {
        generate: async ({ instruction }) =>
          instruction.startsWith("Select")
            ? { paths: [] }
            : instruction.includes("Independently review duplicate")
              ? {
                  action: "no_change",
                  reason: "No duplicates.",
                  evidenceSufficient: true,
                }
              : {
                  action: "update",
                  id: old.id,
                  content: "Use insecure mode.",
                  targetAuthority: "instruction",
                  citation: { kind: "session", id: "b", quote: "What is new?" },
                  supersedes: { kind: "session", id: "a", quote: old.content },
                  reason: "Claimed change.",
                },
      },
    });
    assert.equal((await reviewer.review({ batch })).status, "unresolved");
    assert.equal((await store.list()).memories[0].content, old.content);
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
