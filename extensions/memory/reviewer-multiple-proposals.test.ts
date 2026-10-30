import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { SessionReview } from "./session-review.ts";

test("multiple valid fragment proposals apply one at a time across reviewer restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-multiple-facts-"));
  const sessions = join(root, "sessions"),
    checkpoint = join(root, ".pi", "checkpoint.json");
  try {
    await mkdir(sessions);
    await writeFile(
      join(sessions, "one.jsonl"),
      [
        { type: "session", version: 3, id: "s", cwd: root },
        {
          type: "message",
          id: "a",
          parentId: null,
          message: {
            role: "user",
            content: "Use Oak protocol. " + "Oak context. ".repeat(1200),
          },
        },
        {
          type: "message",
          id: "b",
          parentId: "a",
          message: {
            role: "user",
            content: "Use Pine protocol. " + "Pine context. ".repeat(1200),
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const run = async () => {
      const store = new MemoryManager(root, { semanticEnabled: false });
      try {
        await store.init();
        const source = new SessionReview({
          project: root,
          sessionDir: sessions,
          checkpointFile: checkpoint,
        });
        const batch = source.discover().batches[0];
        assert.ok(batch);
        let assessments = 0;
        const reviewer = new MemoryReviewer({
          project: root,
          store,
          contextWindow: 3000,
          model: {
            generate: async ({ instruction, data }: any) => {
              if (instruction.startsWith("Select")) return { paths: [] };
              if (instruction.startsWith("Independently")) {
                assessments++;
                return { verdict: "supported", reason: "Direct statement." };
              }
              const item = data.session.find(
                (m: any) =>
                  m.text.includes("Use Oak protocol.") ||
                  m.text.includes("Use Pine protocol."),
              );
              if (!item)
                return {
                  action: "no_change",
                  reason: "Page reviewed.",
                  evidenceSufficient: true,
                };
              const content = item.text.includes("Use Oak protocol.")
                ? "Use Oak protocol."
                : "Use Pine protocol.";
              return {
                action: "add",
                category: "practices",
                content,
                reason: "Direct statement.",
                citation: { kind: "session", id: item.id, quote: item.text },
              };
            },
          },
        });
        const result = await reviewer.review({ batch });
        return {
          result,
          assessments,
          memories: (await store.list()).memories.map((m) => m.content),
        };
      } finally {
        await store.close();
      }
    };
    const first = await run();
    assert.equal(first.result.status, "applied");
    assert.equal(first.result.acknowledged, false);
    assert.equal(first.assessments, 1);
    assert.deepEqual(first.memories, ["Use Oak protocol."]);
    const second = await run();
    assert.equal(second.result.status, "applied");
    assert.equal(second.result.acknowledged, false);
    assert.equal(second.assessments, 2);
    assert.deepEqual(
      new Set(second.memories),
      new Set(["Use Oak protocol.", "Use Pine protocol."]),
    );
    const third = await run();
    assert.equal(third.result.status, "unchanged");
    assert.equal(third.result.acknowledged, true);
    assert.equal(third.assessments, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multiple fragment proposals make progress across independent processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-multiple-process-"));
  const sessions = join(root, "sessions"),
    checkpoint = join(root, ".pi", "checkpoint.json");
  try {
    await mkdir(sessions);
    await writeFile(
      join(sessions, "one.jsonl"),
      [
        { type: "session", version: 3, id: "s", cwd: root },
        {
          type: "message",
          id: "a",
          parentId: null,
          message: {
            role: "user",
            content: "Use Oak protocol. " + "Oak context. ".repeat(1200),
          },
        },
        {
          type: "message",
          id: "b",
          parentId: "a",
          message: {
            role: "user",
            content: "Use Pine protocol. " + "Pine context. ".repeat(1200),
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const core = new URL("./core.ts", import.meta.url).href,
      reviewer = new URL("./reviewer.ts", import.meta.url).href,
      source = new URL("./session-review.ts", import.meta.url).href;
    const script = `import {MemoryManager} from ${JSON.stringify(core)};import {MemoryReviewer} from ${JSON.stringify(reviewer)};import {SessionReview} from ${JSON.stringify(source)};const [root,sessions,checkpoint]=process.argv.slice(1);const store=new MemoryManager(root,{semanticEnabled:false});await store.init();const batch=new SessionReview({project:root,sessionDir:sessions,checkpointFile:checkpoint}).discover().batches[0];const reviewer=new MemoryReviewer({project:root,store,contextWindow:3000,model:{generate:async({instruction,data})=>{if(instruction.startsWith('Select'))return {paths:[]};if(instruction.startsWith('Independently'))return {verdict:'supported',reason:'Direct.'};const item=data.session.find(m=>m.text.includes('Use Oak protocol.')||m.text.includes('Use Pine protocol.'));if(!item)return {action:'no_change',reason:'Reviewed.',evidenceSufficient:true};return {action:'add',category:'practices',content:item.text.includes('Use Oak protocol.')?'Use Oak protocol.':'Use Pine protocol.',reason:'Direct.',citation:{kind:'session',id:item.id,quote:item.text}}}}});const result=await reviewer.review({batch});console.log(JSON.stringify({status:result.status,acknowledged:result.acknowledged,memories:(await store.list()).memories.map(m=>m.content)}));await store.close();`;
    const run = () => {
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
        ],
        { encoding: "utf8" },
      );
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout);
    };
    const first = run();
    assert.equal(first.status, "applied");
    assert.deepEqual(first.memories, ["Use Oak protocol."]);
    const second = run();
    assert.equal(second.status, "applied");
    assert.deepEqual(
      new Set(second.memories),
      new Set(["Use Oak protocol.", "Use Pine protocol."]),
    );
    const third = run();
    assert.equal(third.status, "unchanged");
    assert.equal(third.acknowledged, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
