import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { reviewProjectSessions } from "./scheduler.ts";

for (const scenario of [
  "resume",
  "inventory change",
  "resumed mutation",
  "conflicting reason",
  "uncertain dispatch",
  "interrupted re-review",
] as const)
  test(`incremental fragment progress ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-fragment-resume-"));
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    const checkpointFile = join(root, ".pi", "progress", "state.json");
    const store = new MemoryManager(root, { semanticEnabled: false });
    try {
      await store.init();
      await store.remember("knowledge", "A small fact.");
      await writeFile(
        join(sessions, "one.jsonl"),
        [
          { type: "session", version: 3, id: "s", cwd: root },
          {
            type: "message",
            id: "u",
            parentId: null,
            message: { role: "user", content: "Always use TLS. ".repeat(3000) },
          },
        ]
          .map(JSON.stringify)
          .join("\n") + "\n",
      );
      const firstPages: number[] = [],
        resumedPages: number[] = [];
      const controller = new AbortController();
      let reviewDetail = "";
      let writes = 0;
      let sawConflictReason = false;
      const wrapped = {
        captureAddPrecondition: store.captureAddPrecondition.bind(store),
        update: store.update.bind(store),
        forget: store.forget.bind(store),
        move: store.move.bind(store),
        remember: async (...args: Parameters<MemoryManager["remember"]>) => {
          writes++;
          const result = await store.remember(...args);
          if (scenario === "uncertain dispatch")
            throw new Error("post-commit failure");
          return result;
        },
      };
      const makeReviewer = (
        pages: number[],
        abort: boolean,
        restartController?: AbortController,
      ) => {
        const reviewer = new MemoryReviewer({
          project: root,
          store: wrapped,
          contextWindow: 3000,
          continuationKey: "test/mock",
          model: {
            generate: async ({ instruction, data }: any) => {
              if (instruction.startsWith("Select")) return { paths: [] };
              if (instruction.includes("Independently review duplicate"))
                return {
                  action: "no_change",
                  reason: "Reviewed.",
                  evidenceSufficient: true,
                };
              if (instruction.startsWith("Independently")) {
                if (
                  JSON.stringify(data.passReasons ?? []).includes(
                    "TLS conflicts",
                  )
                ) {
                  sawConflictReason = true;
                  return {
                    verdict: "uncertain",
                    reason: "TLS conflicts with earlier guidance.",
                  };
                }
                return { verdict: "supported", reason: "Direct statement." };
              }
              assert.ok(instruction.includes("Review factual corrections"));
              pages.push(data.sessionPage);
              if (abort && pages.length === 2) controller.abort();
              if (restartController && data.sessionPage === 1)
                restartController.abort();
              if (
                !abort &&
                scenario !== "resume" &&
                scenario !== "inventory change" &&
                data.sessionPage === 2
              )
                return {
                  action: "add",
                  category: "practices",
                  content: "Always use TLS.",
                  reason: "Direct instruction.",
                  citation: {
                    kind: "session",
                    id: data.session[0].id,
                    quote: data.session[0].text,
                  },
                };
              return {
                action: "no_change",
                reason:
                  scenario === "conflicting reason" &&
                  !abort &&
                  data.sessionPage === 1
                    ? "TLS conflicts with earlier guidance."
                    : "Reviewed.",
                evidenceSufficient: true,
              };
            },
          },
        });
        const review = reviewer.review.bind(reviewer);
        reviewer.review = async (...args) => {
          const result = await review(...args);
          reviewDetail = result.detail;
          return result;
        };
        return reviewer;
      };
      await assert.rejects(
        reviewProjectSessions({
          project: root,
          sessionDir: sessions,
          checkpointFile,
          reviewer: makeReviewer(firstPages, true),
          signal: controller.signal,
        }),
      );
      assert.deepEqual(firstPages, [1, 2]);
      if (scenario === "inventory change")
        await writeFile(join(root, "new.txt"), "new evidence");
      const run = (
        pages: number[],
        signal: AbortSignal,
        restartController?: AbortController,
      ) =>
        reviewProjectSessions({
          project: root,
          sessionDir: sessions,
          checkpointFile,
          reviewer: makeReviewer(pages, false, restartController),
          signal,
        });
      let result;
      if (scenario === "interrupted re-review") {
        // Interrupt after the saved cursor has been invalidated, not the initial resume.
        const restartController = new AbortController();
        await assert.rejects(
          run(resumedPages, restartController.signal, restartController),
        );
        assert.equal(resumedPages[0], 2);
        assert.equal(resumedPages.at(-1), 1);
        assert.equal(writes, 0);
        const recoveryPages: number[] = [];
        result = await run(recoveryPages, new AbortController().signal);
        assert.equal(recoveryPages[0], 1);
      } else {
        result = await run(resumedPages, new AbortController().signal);
      }
      assert.equal(
        result.status,
        scenario === "uncertain dispatch"
          ? "uncertain"
          : scenario === "conflicting reason"
            ? "unresolved"
            : "done",
      );
      assert.equal(resumedPages[0], scenario === "inventory change" ? 1 : 2);
      if (scenario === "resume") assert.ok(!resumedPages.includes(1));
      if (!["resume", "inventory change"].includes(scenario)) {
        assert.ok(resumedPages.includes(1));
        assert.equal(writes, scenario === "conflicting reason" ? 0 : 1);
        assert.deepEqual(
          (await store.list()).memories.map((memory) => memory.content).sort(),
          (scenario === "conflicting reason"
            ? ["A small fact."]
            : ["A small fact.", "Always use TLS."]
          ).sort(),
        );
        if (scenario === "conflicting reason")
          assert.ok(sawConflictReason, reviewDetail);
        if (scenario === "uncertain dispatch")
          await assert.rejects(access(checkpointFile));
      }
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test("incremental fragment checkpoints resume across independent processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-fragment-process-"));
  const sessions = join(root, "sessions");
  const checkpoint = join(root, ".pi", "progress", "state.json");
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await mkdir(sessions);
    await store.init();
    await store.remember("knowledge", "A small fact.");
    await store.close();
    await writeFile(
      join(sessions, "one.jsonl"),
      [
        { type: "session", version: 3, id: "s", cwd: root },
        {
          type: "message",
          id: "u",
          parentId: null,
          message: { role: "user", content: "session text ".repeat(3000) },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const core = new URL("./core.ts", import.meta.url).href;
    const reviewer = new URL("./reviewer.ts", import.meta.url).href;
    const scheduler = new URL("./scheduler.ts", import.meta.url).href;
    const script = `import { MemoryManager } from ${JSON.stringify(core)}; import { MemoryReviewer } from ${JSON.stringify(reviewer)}; import { reviewProjectSessions } from ${JSON.stringify(scheduler)}; const [root,sessions,checkpoint,mode]=process.argv.slice(1); const store=new MemoryManager(root,{semanticEnabled:false}); const controller=new AbortController(); const pages=[]; const reviewer=new MemoryReviewer({project:root,store,contextWindow:3000,continuationKey:'test/mock',model:{generate:async({instruction,data})=>{if(instruction.startsWith('Select')) return {paths:[]}; if(instruction.includes('Independently review duplicate')) return {action:'no_change',reason:'Reviewed.',evidenceSufficient:true}; if(!instruction.includes('Review factual corrections')) throw new Error('Unexpected instruction'); pages.push(data.sessionPage); if(mode==='abort' && pages.length===2) controller.abort(); return {action:'no_change',reason:'Reviewed.',evidenceSufficient:true};}}}); let status; try { status=(await reviewProjectSessions({project:root,sessionDir:sessions,checkpointFile:checkpoint,reviewer,signal:controller.signal})).status; } catch { status='aborted'; } console.log(JSON.stringify({status,pages})); await store.close();`;
    const run = (mode: string) =>
      spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          script,
          root,
          sessions,
          checkpoint,
          mode,
        ],
        { encoding: "utf8" },
      );
    const first = run("abort");
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), {
      status: "aborted",
      pages: [1, 2],
    });
    const second = run("resume");
    assert.equal(second.status, 0, second.stderr);
    const result = JSON.parse(second.stdout);
    assert.equal(result.status, "done");
    assert.equal(result.pages[0], 2);
    assert.ok(!result.pages.includes(1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
