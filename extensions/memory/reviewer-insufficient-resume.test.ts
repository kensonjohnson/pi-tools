import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { reviewProjectSessions } from "./scheduler.ts";

for (const legacy of [false, true])
  test(`insufficient fragments are reassessed after restart${legacy ? " with a legacy completed cursor" : ""}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-insufficient-resume-"));
    const sessions = join(root, "sessions"),
      checkpointFile = join(root, ".pi", "progress", "state.json");
    try {
      await mkdir(sessions);
      await writeFile(
        join(sessions, "one.jsonl"),
        [
          { type: "session", version: 3, id: "s", cwd: root },
          {
            type: "message",
            id: "u",
            parentId: null,
            message: { role: "user", content: "Context ".repeat(5000) },
          },
        ]
          .map(JSON.stringify)
          .join("\n") + "\n",
      );
      const pages: number[] = [];
      let total = 0;
      const run = async (sufficient: boolean) => {
        const store = new MemoryManager(root, { semanticEnabled: false });
        try {
          await store.init();
          const reviewer = new MemoryReviewer({
            project: root,
            store,
            contextWindow: 3000,
            continuationKey: "test/mock",
            model: {
              generate: async ({ instruction, data }: any) => {
                if (instruction.startsWith("Select")) return { paths: [] };
                pages.push(data.sessionPage);
                total = data.sessionPages;
                return {
                  action: "no_change",
                  reason: "Reviewed.",
                  evidenceSufficient:
                    sufficient || data.sessionPage !== data.sessionPages,
                };
              },
            },
          });
          return reviewProjectSessions({
            project: root,
            sessionDir: sessions,
            checkpointFile,
            reviewer,
            signal: new AbortController().signal,
          });
        } finally {
          await store.close();
        }
      };
      assert.equal((await run(false)).status, "unresolved");
      assert.ok(total > 1);
      const db = new Database(`${checkpointFile}.incremental.db`);
      try {
        const row: any = db.prepare("SELECT path, fragment FROM cursors").get();
        assert.ok(row);
        const fragment = JSON.parse(row.fragment);
        assert.equal(fragment.sufficient, true);
        assert.equal(fragment.index, total - 1);
        if (legacy)
          db.prepare("UPDATE cursors SET fragment=? WHERE path=?").run(
            JSON.stringify({ ...fragment, index: total, sufficient: false }),
            row.path,
          );
      } finally {
        db.close();
      }
      pages.length = 0;
      assert.equal((await run(true)).status, "done");
      assert.ok(pages.length > 0);
      assert.equal(pages[0], legacy ? 1 : total);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

for (const legacy of [false, true])
  test(`insufficient incremental checkpoint is reassessed in new processes${legacy ? " with a legacy cursor" : ""}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-insufficient-process-"));
    const sessions = join(root, "sessions"),
      checkpoint = join(root, ".pi", "progress", "state.json");
    try {
      await mkdir(sessions);
      await writeFile(
        join(sessions, "one.jsonl"),
        [
          { type: "session", version: 3, id: "s", cwd: root },
          {
            type: "message",
            id: "u",
            parentId: null,
            message: { role: "user", content: "Context ".repeat(5000) },
          },
        ]
          .map(JSON.stringify)
          .join("\n") + "\n",
      );
      const core = new URL("./core.ts", import.meta.url).href,
        reviewer = new URL("./reviewer.ts", import.meta.url).href,
        scheduler = new URL("./scheduler.ts", import.meta.url).href;
      const script = `import {MemoryManager} from ${JSON.stringify(core)};import {MemoryReviewer} from ${JSON.stringify(reviewer)};import {reviewProjectSessions} from ${JSON.stringify(scheduler)};const [root,sessions,checkpoint,mode]=process.argv.slice(1);const store=new MemoryManager(root,{semanticEnabled:false});await store.init();const pages=[];const reviewer=new MemoryReviewer({project:root,store,contextWindow:3000,continuationKey:'test/mock',model:{generate:async({instruction,data})=>{if(instruction.startsWith('Select'))return {paths:[]};pages.push(data.sessionPage);return {action:'no_change',reason:'Reviewed.',evidenceSufficient:mode==='sufficient'||data.sessionPage!==data.sessionPages}}}});const result=await reviewProjectSessions({project:root,sessionDir:sessions,checkpointFile:checkpoint,reviewer,signal:new AbortController().signal});console.log(JSON.stringify({status:result.status,pages}));await store.close();`;
      const run = (mode: string) => {
        const child = spawnSync(
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
        assert.equal(child.status, 0, child.stderr);
        return JSON.parse(child.stdout);
      };
      const first = run("insufficient");
      assert.equal(first.status, "unresolved");
      assert.ok(first.pages.length > 1);
      if (legacy) {
        const db = new Database(`${checkpoint}.incremental.db`);
        try {
          const row: any = db
            .prepare("SELECT path,fragment FROM cursors")
            .get();
          const fragment = JSON.parse(row.fragment);
          db.prepare("UPDATE cursors SET fragment=? WHERE path=?").run(
            JSON.stringify({
              ...fragment,
              index: first.pages.length,
              sufficient: false,
            }),
            row.path,
          );
        } finally {
          db.close();
        }
      }
      const second = run("insufficient");
      assert.equal(second.status, "unresolved");
      assert.ok(second.pages.length > 0);
      assert.equal(second.pages[0], legacy ? 1 : first.pages.at(-1));
      const third = run("sufficient");
      assert.equal(third.status, "done");
      assert.deepEqual(third.pages, [first.pages.at(-1)]);
      const fourth = run("sufficient");
      assert.equal(fourth.status, "done");
      assert.deepEqual(fourth.pages, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
