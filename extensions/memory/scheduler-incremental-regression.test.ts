import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  access,
  appendFile,
  readFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { MemoryScheduler, reviewProjectSessions } from "./scheduler.ts";

async function fixture(fn: (root: string, sessions: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "memory-scheduler-pages-"));
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  try {
    await fn(root, sessions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("incremental pages survive reviewer and process-style restarts, and stale snapshots restart", async () => {
  await fixture(async (root, sessions) => {
    const memoryDir = join(root, ".pi/memory");
    await mkdir(memoryDir, { recursive: true });
    const memoryFile = join(memoryDir, "knowledge.ndjson");
    const entries =
      Array.from({ length: 1201 }, (_, i) =>
        JSON.stringify({
          id: `id-${i}`,
          content: `memory ${i}`,
          created: "2025",
        }),
      ).join("\n") + "\n";
    await writeFile(memoryFile, entries);
    await writeFile(
      join(sessions, "one.jsonl"),
      [
        { type: "session", version: 3, id: "s", cwd: root },
        {
          type: "message",
          id: "a",
          parentId: null,
          message: { role: "user", content: "hello" },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const checkpointFile = join(root, "state/progress.json");
    const offsets: number[] = [];
    const run = async () => {
      const store = new MemoryManager(root, { semanticEnabled: false });
      let previous: number | undefined;
      const reviewer = new MemoryReviewer({
        project: root,
        store,
        contextWindow: 1500,
        model: {
          generate: async ({ instruction, data }: any) => {
            if (instruction.startsWith("Select")) {
              const first = Number(data.memories[0]?.id.slice(3) ?? 1201);
              if (previous !== first) offsets.push(first);
              previous = first;
              return { paths: [] };
            }
            return {
              action: "no_change",
              evidenceSufficient: true,
              reason: "Session reviewed.",
            };
          },
        },
      });
      try {
        return await reviewProjectSessions({
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
    assert.equal((await run()).status, "pending");
    assert.equal(offsets.length, 24);
    await assert.rejects(access(checkpointFile));
    // A stale cursor cannot skip pages after a manual memory change.
    await writeFile(memoryFile, entries.replace("memory 0", "edited memory 0"));
    assert.equal((await run()).status, "pending");
    assert.equal(offsets[24], 0);
    assert.equal((await run()).status, "done");
    await access(checkpointFile);
    assert.ok(offsets.at(-1)! > offsets.at(-2)! && offsets.at(-1)! < 1201);
    assert.equal((await run()).status, "done");
  });
});

test("appends during paged review retain the original session boundary", async () => {
  await fixture(async (root, sessions) => {
    const memoryDir = join(root, ".pi/memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, "knowledge.ndjson"),
      Array.from({ length: 1201 }, (_, i) =>
        JSON.stringify({
          id: `id-${i}`,
          content: `memory ${i}`,
          created: "2025",
        }),
      ).join("\n") + "\n",
    );
    const session = join(sessions, "one.jsonl");
    await writeFile(
      session,
      [
        { type: "session", version: 3, id: "s", cwd: root },
        {
          type: "message",
          id: "a",
          parentId: null,
          message: { role: "user", content: "first" },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const checkpointFile = join(root, "state/progress.json");
    const observed: string[][] = [];
    const run = async () => {
      const store = new MemoryManager(root, { semanticEnabled: false });
      let previous: string | undefined;
      const reviewer = new MemoryReviewer({
        project: root,
        store,
        contextWindow: 1500,
        model: {
          generate: async ({ instruction, data }: any) => {
            if (instruction.startsWith("Select")) {
              if (previous !== data.memories[0]?.id)
                observed.push(data.session.map((item: any) => item.id));
              previous = data.memories[0]?.id;
              return { paths: [] };
            }
            return {
              action: "no_change",
              evidenceSufficient: true,
              reason: "Session reviewed.",
            };
          },
        },
      });
      try {
        return await reviewProjectSessions({
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
    assert.equal((await run()).status, "pending");
    await appendFile(
      session,
      JSON.stringify({
        type: "message",
        id: "b",
        parentId: "a",
        message: { role: "user", content: "second" },
      }) + "\n",
    );
    assert.equal((await run()).status, "pending");
    assert.deepEqual(observed[24], ["a"]);
    assert.equal(
      JSON.parse(await readFile(checkpointFile, "utf8")).sessions[session].leaf,
      "a",
    );
    await appendFile(
      session,
      JSON.stringify({
        type: "message",
        id: "c",
        parentId: "b",
        message: { role: "user", content: "third" },
      }) + "\n",
    );
    assert.equal((await run()).status, "pending");
    await appendFile(
      session,
      JSON.stringify({
        type: "message",
        id: "d",
        parentId: "c",
        message: { role: "user", content: "fourth" },
      }) + "\n",
    );
    let leaf = JSON.parse(await readFile(checkpointFile, "utf8")).sessions[
      session
    ].leaf;
    for (let i = 0; i < 10 && leaf !== "c"; i++) {
      assert.equal((await run()).status, "pending");
      assert.deepEqual(observed.at(-1), ["b", "c"]);
      leaf = JSON.parse(await readFile(checkpointFile, "utf8")).sessions[
        session
      ].leaf;
    }
    assert.equal(leaf, "c");
  });
});

test("branch replacement or truncation discards prior page progress", async () => {
  for (const change of ["branch", "truncate", "rewrite-same-items"])
    await fixture(async (root, sessions) => {
      const memoryDir = join(root, ".pi/memory");
      await mkdir(memoryDir, { recursive: true });
      await writeFile(
        join(memoryDir, "knowledge.ndjson"),
        Array.from({ length: 1201 }, (_, i) =>
          JSON.stringify({
            id: `id-${i}`,
            content: `memory ${i}`,
            created: "2025",
          }),
        ).join("\n") + "\n",
      );
      const session = join(sessions, "one.jsonl");
      const header = { type: "session", version: 3, id: "s", cwd: root };
      const first = {
        type: "message",
        id: "a",
        parentId: null,
        message: { role: "user", content: "first" },
      };
      const replacement = {
        type: "message",
        id: "b",
        parentId: null,
        message: { role: "user", content: "replacement" },
      };
      await writeFile(
        session,
        [header, first].map(JSON.stringify).join("\n") + "\n",
      );
      const checkpointFile = join(root, "state/progress.json");
      const observed: Array<{ first: string; session: string[] }> = [];
      const run = async () => {
        const store = new MemoryManager(root, { semanticEnabled: false });
        let previous: string | undefined;
        const reviewer = new MemoryReviewer({
          project: root,
          store,
          contextWindow: 1500,
          model: {
            generate: async ({ instruction, data }: any) => {
              if (instruction.startsWith("Select")) {
                if (previous !== data.memories[0]?.id)
                  observed.push({
                    first: data.memories[0].id,
                    session: data.session.map((item: any) => item.id),
                  });
                previous = data.memories[0]?.id;
                return { paths: [] };
              }
              return {
                action: "no_change",
                evidenceSufficient: true,
                reason: "Session reviewed.",
              };
            },
          },
        });
        try {
          return await reviewProjectSessions({
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
      assert.equal((await run()).status, "pending");
      if (change === "branch")
        await appendFile(session, JSON.stringify(replacement) + "\n");
      else
        await writeFile(
          session,
          (change === "rewrite-same-items"
            ? [{ ...header, timestamp: "changed" }, first]
            : [header, replacement]
          )
            .map(JSON.stringify)
            .join("\n") + "\n",
        );
      assert.equal((await run()).status, "pending");
      assert.deepEqual(observed[24], {
        first: "id-0",
        session: [change === "rewrite-same-items" ? "a" : "b"],
      });
      await assert.rejects(access(checkpointFile));
    });
});

test("incremental cursor resumes across independent processes", async () => {
  await fixture(async (root, sessions) => {
    const memoryDir = join(root, ".pi/memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, "knowledge.ndjson"),
      Array.from({ length: 1201 }, (_, i) =>
        JSON.stringify({
          id: `id-${i}`,
          content: `memory ${i}`,
          created: "2025",
        }),
      ).join("\n") + "\n",
    );
    await writeFile(
      join(sessions, "one.jsonl"),
      [
        { type: "session", version: 3, id: "s", cwd: root },
        {
          type: "message",
          id: "a",
          parentId: null,
          message: { role: "user", content: "hello" },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const checkpoint = join(root, "state/progress.json");
    const core = new URL("./core.ts", import.meta.url).href;
    const reviewer = new URL("./reviewer.ts", import.meta.url).href;
    const scheduler = new URL("./scheduler.ts", import.meta.url).href;
    const script = `import { MemoryManager } from ${JSON.stringify(core)}; import { MemoryReviewer } from ${JSON.stringify(reviewer)}; import { reviewProjectSessions } from ${JSON.stringify(scheduler)}; const [root,dir,checkpoint]=process.argv.slice(1); const store=new MemoryManager(root,{semanticEnabled:false}); const r=new MemoryReviewer({project:root,store,contextWindow:1500,model:{generate:async({instruction})=>instruction.startsWith('Select')?{paths:[]}:{action:'no_change',evidenceSufficient:true,reason:'Session reviewed.'}}}); const out=await reviewProjectSessions({project:root,sessionDir:dir,checkpointFile:checkpoint,reviewer:r,signal:new AbortController().signal}); console.log(out.status); await store.close();`;
    const run = () =>
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
        ],
        { encoding: "utf8" },
      );
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.trim(), "pending");
    await assert.rejects(access(checkpoint));
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout.trim(), "done");
    await access(checkpoint);
  });
});

test("a failing directory cannot starve another pending directory", async () => {
  await fixture(async (root, sessions) => {
    const healthy = join(root, "z-healthy");
    await mkdir(healthy);
    const seen: string[] = [];
    const scheduler = new MemoryScheduler({
      project: root,
      runtimeDir: join(root, "state"),
      sessionDir: sessions,
      additionalSessionDirs: [healthy],
      debounceMs: 0,
      cooldownMs: 0,
      retryMs: 5,
      work: async (directory) => {
        seen.push(directory);
        return directory === sessions
          ? { status: "error", detail: "unavailable" }
          : { status: "done" };
      },
    });
    try {
      await scheduler.activity();
      for (let i = 0; i < 300 && !seen.includes(healthy); i++)
        await new Promise((r) => setTimeout(r, 5));
      assert.deepEqual(seen.slice(0, 2), [sessions, healthy]);
      assert.equal(scheduler.status().pending, 1);
      assert.ok(
        scheduler.report().events.some((entry) => entry.status === "error"),
      );
    } finally {
      await scheduler.shutdown();
    }
  });
});
