import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryManager } from "./core.ts";

test("memory fragments resume across processes without skipping the interrupted fragment", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-fragment-process-"));
  const sessions = join(root, "sessions"),
    checkpoint = join(root, ".pi", "progress", "state.json");
  const store = new MemoryManager(root, { semanticEnabled: false });
  try {
    await mkdir(sessions);
    await store.init();
    const content = "A long memory 😀 ".repeat(3000).trim();
    await store.remember("knowledge", content);
    await store.close();
    await writeFile(
      join(sessions, "one.jsonl"),
      [
        { type: "session", version: 3, id: "s", cwd: root },
        {
          type: "message",
          id: "u",
          parentId: null,
          message: { role: "user", content: "Review the record." },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const core = new URL("./core.ts", import.meta.url).href,
      reviewer = new URL("./reviewer.ts", import.meta.url).href,
      scheduler = new URL("./scheduler.ts", import.meta.url).href;
    const script = `import {MemoryManager} from ${JSON.stringify(core)};import {MemoryReviewer} from ${JSON.stringify(reviewer)};import {reviewProjectSessions} from ${JSON.stringify(scheduler)};const [root,sessions,checkpoint,mode]=process.argv.slice(1);const store=new MemoryManager(root,{semanticEnabled:false});const controller=new AbortController();const pages=[];const reviewer=new MemoryReviewer({project:root,store,contextWindow:3000,continuationKey:'test/mock',model:{generate:async({instruction,data})=>{if(instruction.startsWith('Select'))return {paths:[]};if(instruction.includes('Independently review duplicate'))return {action:'no_change',reason:'Reviewed.',evidenceSufficient:true};if(!instruction.includes('Review factual corrections'))throw new Error('Unexpected instruction');pages.push({page:data.memoryPage,text:data.memories[0].content});if(mode==='abort'&&pages.length===2)controller.abort();return {action:'no_change',reason:'Reviewed.',evidenceSufficient:true};}}});let status;try{status=(await reviewProjectSessions({project:root,sessionDir:sessions,checkpointFile:checkpoint,reviewer,signal:controller.signal})).status}catch{status='aborted'}console.log(JSON.stringify({status,pages}));await store.close();`;
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
    const one = JSON.parse(first.stdout);
    assert.equal(one.status, "aborted");
    assert.deepEqual(
      one.pages.map((p: any) => p.page),
      [1, 2],
    );
    const second = run("resume");
    assert.equal(second.status, 0, second.stderr);
    const two = JSON.parse(second.stdout);
    assert.equal(two.status, "done");
    assert.equal(two.pages[0].page, 2);
    assert.equal(
      [one.pages[0], ...two.pages].map((p: any) => p.text).join(""),
      content,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
