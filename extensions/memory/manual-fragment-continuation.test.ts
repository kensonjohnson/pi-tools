import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { MemoryScheduler } from "./scheduler.ts";
import { reviewAllMemories } from "./manual-review.ts";

for (const stale of [false, true])
  test(`manual fragment progress ${stale ? "restarts after memory changes" : "survives scheduler and reviewer restart"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "manual-fragment-"));
    const store = new MemoryManager(root, { semanticEnabled: false });
    const runtime = join(root, ".pi", "runtime");
    const makeScheduler = () =>
      new MemoryScheduler({
        project: root,
        runtimeDir: runtime,
        sessionDir: join(root, ".pi", "sessions"),
        automatic: false,
        work: async () => ({ status: "done" }),
      });
    let scheduler: MemoryScheduler | undefined;
    try {
      await store.init();
      await writeFile(join(root, "evidence.txt"), "Source text. ".repeat(9000));
      let pages: number[] = [];
      let abort = true;
      const execute = async (control: MemoryScheduler) =>
        control.runManual(async (signal, progress) => {
          const reviewer = new MemoryReviewer({
            project: root,
            store,
            contextWindow: 3000,
            continuationKey: "test/mock",
            fullContinuation: progress.resumePermit,
            model: {
              generate: async ({ instruction, data }: any) => {
                if (instruction.startsWith("Select"))
                  return { paths: ["evidence.txt"] };
                pages.push(data.evidencePage);
                if (abort && pages.length === 2) control.cancel();
                return {
                  action: "no_change",
                  reason: "Reviewed.",
                  evidenceSufficient: true,
                };
              },
            },
          });
          return reviewAllMemories({
            reviewer,
            signal,
            fullOffset: progress.current?.offset,
            fullSnapshot: progress.current?.snapshot,
            onProgress: (cursor) =>
              cursor ? progress.advance(cursor) : progress.clear(),
          });
        });
      scheduler = makeScheduler();
      assert.equal((await execute(scheduler)).status, "uncertain");
      assert.deepEqual(pages, [1, 2]);
      await scheduler.shutdown();
      if (stale) await store.remember("knowledge", "A newly added fact.");
      scheduler = makeScheduler();
      scheduler.resume({ schedule: false });
      pages = [];
      abort = false;
      assert.equal((await execute(scheduler)).status, "done");
      assert.equal(pages[0], stale ? 1 : 2);
      if (!stale) assert.ok(!pages.includes(1));
    } finally {
      await scheduler?.shutdown();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test("manual fragment progress survives independent processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "manual-fragment-process-"));
  try {
    await writeFile(join(root, "evidence.txt"), "Source text. ".repeat(9000));
    const core = new URL("./core.ts", import.meta.url).href;
    const reviewer = new URL("./reviewer.ts", import.meta.url).href;
    const scheduler = new URL("./scheduler.ts", import.meta.url).href;
    const manual = new URL("./manual-review.ts", import.meta.url).href;
    const script = `import {MemoryManager} from ${JSON.stringify(core)};import {MemoryReviewer} from ${JSON.stringify(reviewer)};import {MemoryScheduler} from ${JSON.stringify(scheduler)};import {reviewAllMemories} from ${JSON.stringify(manual)};import {join} from 'node:path';const [root,mode]=process.argv.slice(1);const store=new MemoryManager(root,{semanticEnabled:false});await store.init();const control=new MemoryScheduler({project:root,runtimeDir:join(root,'.pi/runtime'),sessionDir:join(root,'.pi/sessions'),automatic:false,work:async()=>({status:'done'})});if(mode==='resume')control.resume({schedule:false});const pages=[];const result=await control.runManual(async(signal,progress)=>{const reviewer=new MemoryReviewer({project:root,store,contextWindow:3000,continuationKey:'test/mock',fullContinuation:progress.resumePermit,model:{generate:async({instruction,data})=>{if(instruction.startsWith('Select'))return {paths:['evidence.txt']};pages.push(data.evidencePage);if(mode==='abort'&&pages.length===2)control.cancel();return {action:'no_change',reason:'Reviewed.',evidenceSufficient:true}}}});return reviewAllMemories({reviewer,signal,fullOffset:progress.current?.offset,fullSnapshot:progress.current?.snapshot,onProgress:(cursor)=>cursor?progress.advance(cursor):progress.clear()})});console.log(JSON.stringify({status:result.status,pages}));await control.shutdown();await store.close();`;
    const run = (mode: string) =>
      spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          script,
          root,
          mode,
        ],
        { encoding: "utf8" },
      );
    const first = run("abort");
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), {
      status: "uncertain",
      pages: [1, 2],
    });
    const second = run("resume");
    assert.equal(second.status, 0, second.stderr);
    const resumed = JSON.parse(second.stdout);
    assert.equal(resumed.status, "done");
    assert.equal(resumed.pages[0], 2);
    assert.ok(!resumed.pages.includes(1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
