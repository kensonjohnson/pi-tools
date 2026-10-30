import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { reviewProjectSessions } from "./scheduler.ts";

test("uncertain partial-session mutation is not automatically replayed or acknowledged", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-uncertain-no-replay-"));
  const sessions = join(root, "sessions"),
    checkpointFile = join(root, ".pi", "state.json");
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await mkdir(sessions);
    await store.init();
    await writeFile(
      join(sessions, "one.jsonl"),
      [
        { type: "session", version: 3, id: "s", cwd: root },
        {
          type: "message",
          id: "u",
          parentId: null,
          message: {
            role: "user",
            content: "Use Oak protocol. " + "context ".repeat(4000),
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    let writes = 0;
    const wrapped = {
      captureAddPrecondition: store.captureAddPrecondition.bind(store),
      update: store.update.bind(store),
      forget: store.forget.bind(store),
      move: store.move.bind(store),
      remember: async (...args: Parameters<MemoryManager["remember"]>) => {
        writes++;
        await store.remember(...args);
        throw new Error("post-commit failure");
      },
    };
    const reviewer = new MemoryReviewer({
      project: root,
      store: wrapped,
      contextWindow: 3000,
      continuationKey: "test/mock",
      model: {
        generate: async ({ instruction, data }: any) => {
          if (instruction.startsWith("Select")) return { paths: [] };
          if (instruction.startsWith("Independently"))
            return { verdict: "supported", reason: "Direct statement." };
          const item = data.session.find((s: any) =>
            s.text.includes("Use Oak protocol."),
          );
          return item
            ? {
                action: "add",
                category: "practices",
                content: "Use Oak protocol.",
                reason: "Direct.",
                citation: { kind: "session", id: item.id, quote: item.text },
              }
            : {
                action: "no_change",
                reason: "Reviewed.",
                evidenceSufficient: true,
              };
        },
      },
    });
    const result = await reviewProjectSessions({
      project: root,
      sessionDir: sessions,
      checkpointFile,
      reviewer,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "uncertain");
    assert.equal(writes, 1);
    assert.equal((await store.list()).memories.length, 1);
    await assert.rejects(access(checkpointFile));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
