import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MemoryManager } from "./core.ts";
import { SessionReview } from "./session-review.ts";
import { MemoryReviewer } from "./reviewer.ts";

test("active branch replacement before apply rejects stale session evidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-session-"));
  const dir = join(cwd, "sessions");
  await mkdir(dir);
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.init();
    const sm = SessionManager.create(cwd, dir);
    const first = sm.appendMessage({
      role: "user",
      content: "Project uses secure mode.",
      timestamp: 1,
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
      timestamp: 1,
    } as any);
    const sessions = new SessionReview({
      project: cwd,
      sessionDir: dir,
      checkpointFile: join(cwd, "checkpoint"),
    });
    const batch = sessions.discover().batches[0];
    assert.ok(batch);
    const r = new MemoryReviewer({
      project: cwd,
      store,
      model: {
        generate: async ({ instruction }) => {
          if (instruction.startsWith("Select")) return { paths: [] };
          if (instruction.includes("Independently review duplicate"))
            return {
              action: "no_change",
              reason: "No duplicates.",
              evidenceSufficient: true,
            };
          if (instruction.startsWith("Independently"))
            return {
              verdict: "supported",
              reason: "User statement supports it.",
            };
          sm.branch(first);
          sm.appendMessage({
            role: "user",
            content: "Alternative branch",
            timestamp: 2,
          });
          return {
            action: "add",
            category: "knowledge",
            content: "Project uses secure mode.",
            reason: "Direct user statement supports this proposal.",
            citation: {
              kind: "session",
              id: first,
              quote: "Project uses secure mode.",
            },
          };
        },
      },
    });
    await assert.rejects(r.review({ batch }), /branch changed/);
    assert.equal((await store.list()).memories.length, 0);
    assert.equal(sessions.discover().batches.length, 1);
    sessions.close();
  } finally {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
