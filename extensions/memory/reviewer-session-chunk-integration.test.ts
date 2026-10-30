import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { reviewProjectSessions } from "./scheduler.ts";

test("scheduler acknowledges source-validated long-message chunks only after each is reviewed", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-source-chunks-"));
  const sessions = join(root, "sessions");
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await mkdir(sessions);
    await store.init();
    const text = "source text 😀 ".repeat(8000);
    await writeFile(
      join(sessions, "one.jsonl"),
      [
        { type: "session", version: 3, id: "s", cwd: root },
        {
          type: "message",
          id: "u",
          parentId: null,
          message: { role: "user", content: text },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const parts: string[] = [];
    let rejectNext = false,
      rejected = "";
    const run = async () => {
      const reviewer = new MemoryReviewer({
        project: root,
        store,
        contextWindow: 100000,
        model: {
          generate: async ({ instruction, data }: any) => {
            if (instruction.startsWith("Select")) return { paths: [] };
            assert.equal(data.sessionFragmented, true);
            assert.ok(data.session[0].chunk);
            if (rejectNext) rejected = data.session[0].text;
            else parts.push(data.session[0].text);
            return {
              action: "no_change",
              reason: "Reviewed chunk.",
              evidenceSufficient: !rejectNext,
            };
          },
        },
      });
      return reviewProjectSessions({
        project: root,
        sessionDir: sessions,
        checkpointFile: join(root, ".pi", "progress", "state.json"),
        reviewer,
        signal: new AbortController().signal,
      });
    };
    let outcome = await run();
    assert.equal(outcome.status, "pending");
    rejectNext = true;
    outcome = await run();
    assert.equal(outcome.status, "unresolved");
    assert.ok(rejected);
    rejectNext = false;
    outcome = await run();
    assert.equal(parts.at(-1), rejected);
    for (let i = 0; i < 10 && outcome.status === "pending"; i++)
      outcome = await run();
    assert.equal(outcome.status, "done");
    assert.ok(parts.length > 1);
    assert.equal(parts.join(""), text);
    assert.equal((await store.list()).memories.length, 0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
