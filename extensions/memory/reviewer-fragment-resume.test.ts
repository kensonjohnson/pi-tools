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
      const makeReviewer = (pages: number[], abort: boolean) => {
        const reviewer = new MemoryReviewer({
          project: root,
          store,
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
              if (instruction.startsWith("Independently"))
                return { verdict: "supported", reason: "Direct statement." };
              assert.ok(instruction.includes("Review factual corrections"));
              pages.push(data.sessionPage);
              if (abort && pages.length === 2) controller.abort();
              if (
                !abort &&
                scenario === "resumed mutation" &&
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
                reason: "Reviewed.",
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
      const result = await reviewProjectSessions({
        project: root,
        sessionDir: sessions,
        checkpointFile,
        reviewer: makeReviewer(resumedPages, false),
        signal: new AbortController().signal,
      });
      assert.equal(
        result.status,
        scenario === "resumed mutation" ? "unresolved" : "done",
      );
      assert.ok(resumedPages.length > 0);
      assert.equal(resumedPages[0], scenario === "inventory change" ? 1 : 2);
      if (scenario !== "inventory change") assert.ok(!resumedPages.includes(1));
      if (scenario === "resumed mutation") {
        assert.match(
          reviewDetail,
          /prior fragment review reasons are unavailable/i,
        );
        await assert.rejects(access(checkpointFile));
        assert.deepEqual(
          (await store.list()).memories.map((memory) => memory.content),
          ["A small fact."],
        );
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
