import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import extension from "./index.ts";
import { MemoryScheduler } from "./scheduler.ts";

test("startup SQLite contention spools settled activity and retries without blocking", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "scheduler-boot-")),
    agent = await mkdtemp(join(tmpdir(), "scheduler-agent-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  let lock: Database.Database | undefined;
  try {
    const dir = join(cwd, "sessions"),
      path = join(dir, "one.jsonl"),
      runtimeDir = join(cwd, ".pi", "memory", ".runtime", "review-scheduler");
    await mkdir(dir);
    await mkdir(join(cwd, ".pi", "memory"), { recursive: true });
    await writeFile(
      path,
      [
        { type: "session", version: 3, id: "s", cwd },
        {
          type: "message",
          id: "a",
          parentId: null,
          message: { role: "user", content: "hello" },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    );
    await writeFile(
      join(cwd, ".pi", "pi-tools.json"),
      JSON.stringify({
        version: 1,
        extensions: {
          memory: {
            historyReview: { debounceSeconds: 0, cooldownSeconds: 0 },
            models: { reviewer: "test/model" },
          },
        },
      }),
    );
    const initial = new MemoryScheduler({
      project: cwd,
      runtimeDir,
      sessionDir: dir,
      work: async () => ({ status: "done" }),
    });
    await initial.shutdown();
    lock = new Database(join(runtimeDir, "scheduler.sqlite"), { timeout: 0 });
    lock.exec("BEGIN IMMEDIATE");
    let calls = 0;
    const ctx: any = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: { getSessionDir: () => dir, getSessionFile: () => path },
      modelRegistry: {
        find: () => ({ provider: "test", id: "model", input: ["text"] }),
        getAvailable: () => [],
        getApiKeyAndHeaders: async () => ({ ok: true }),
        complete: async (_model: unknown, request: any) => {
          calls++;
          return {
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: request.systemPrompt.includes("Select evidence requests")
                  ? '{"paths":[]}'
                  : '{"action":"no_change","reason":"Reviewed.","evidenceSufficient":true}',
              },
            ],
          };
        },
      },
    };
    const handlers = new Map<string, Function>();
    const pi: any = {
      events: {
        on() {
          return () => {};
        },
        emit() {},
      },
      on(name: string, cb: Function) {
        handlers.set(name, cb);
      },
      registerTool() {},
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    };
    extension(pi);
    const before = Date.now();
    await handlers.get("session_start")!({}, ctx);
    assert.ok(Date.now() - before < 500);
    handlers.get("agent_settled")!({}, ctx);
    let persisted = false;
    for (let i = 0; i < 100 && !persisted; i++) {
      persisted = (await readdir(join(runtimeDir, "signals"))).some((x) =>
        x.endsWith(".json"),
      );
      if (!persisted) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(persisted, true);
    assert.equal(calls, 0);
    lock.exec("ROLLBACK");
    lock.close();
    lock = undefined;
    for (let i = 0; i < 250 && calls < 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 3);
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    lock?.close();
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
