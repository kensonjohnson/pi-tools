import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { reviewProjectSessions } from "./scheduler.ts";

for (const verdict of ["supported", "uncertain"] as const)
  test(`validated direct user chunk needs ${verdict} assessment before learning`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-chunk-learning-"));
    const sessions = join(root, "sessions");
    const store = new MemoryManager(root, { semanticEnabled: false });
    try {
      await mkdir(sessions);
      await store.init();
      const text =
        "Always use TLS. " + "Additional user context. ".repeat(5000);
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
      let assessments = 0;
      const run = async () => {
        const reviewer = new MemoryReviewer({
          project: root,
          store,
          contextWindow: 100000,
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
                assert.match(
                  instruction,
                  /surrounding message text may be omitted/,
                );
                assert.ok(data.session[0].chunk);
                return {
                  verdict,
                  reason: "Assessed the excerpt and omitted context.",
                };
              }
              if (
                data.memories.some((m: any) => m.content === "Always use TLS.")
              )
                return {
                  action: "no_change",
                  reason: "Already stored.",
                  evidenceSufficient: true,
                };
              assert.ok(data.session[0].chunk);
              return {
                action: "add",
                category: "practices",
                content: "Always use TLS.",
                reason: "Direct user statement.",
                citation: {
                  kind: "session",
                  id: "u",
                  quote: data.session[0].text,
                },
              };
            },
          },
        });
        return reviewProjectSessions({
          project: root,
          sessionDir: sessions,
          checkpointFile: join(root, ".pi", "state.json"),
          reviewer,
          signal: new AbortController().signal,
        });
      };
      let result = await run();
      assert.ok(assessments > 0);
      if (verdict === "uncertain") {
        assert.equal(result.status, "unresolved");
        assert.equal((await store.list()).memories.length, 0);
        return;
      }
      assert.equal(result.status, "pending");
      for (let i = 0; i < 10 && result.status === "pending"; i++)
        result = await run();
      assert.equal(result.status, "done");
      assert.equal((await store.list()).memories[0].content, "Always use TLS.");
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

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
            if (instruction.includes("Independently review duplicate"))
              return {
                action: "no_change",
                reason: "Reviewed.",
                evidenceSufficient: true,
              };
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
