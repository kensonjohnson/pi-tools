import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { MemoryScheduler, UNSUPPORTED_FILE_SOURCE } from "./scheduler.ts";

test("live Pi explicit custom.session stays durably unavailable rather than complete", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "scheduler-custom-")),
    agent = await mkdtemp(join(tmpdir(), "scheduler-agent-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const runtime = join(cwd, ".pi", "memory", ".runtime", "review-scheduler");
  let resumed: MemoryScheduler | undefined;
  try {
    const customDir = join(cwd, "external"),
      defaultDir = join(cwd, "standard"),
      sessionPath = join(customDir, "custom.session");
    await mkdir(customDir);
    await mkdir(defaultDir);
    await mkdir(join(cwd, ".pi", "memory"), { recursive: true });
    await writeFile(
      sessionPath,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "custom",
        timestamp: new Date().toISOString(),
        cwd,
      }) + "\n",
    );
    const sessionManager = SessionManager.open(sessionPath, defaultDir, cwd);
    sessionManager.appendMessage({
      role: "user",
      content: "Project uses a custom session.",
      timestamp: Date.now(),
    });
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
    let providerCalls = 0;
    const ctx: any = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager,
      modelRegistry: {
        find() {
          providerCalls++;
        },
        getAvailable() {
          return [];
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
    await handlers.get("session_start")!({}, ctx);
    handlers.get("agent_settled")!({}, ctx);
    let pending = false;
    for (let i = 0; i < 300 && !pending; i++) {
      try {
        const db = new Database(join(runtime, "scheduler.sqlite"), {
          readonly: true,
        });
        const row = db
          .prepare("SELECT pending,completed FROM directories WHERE path=?")
          .get(UNSUPPORTED_FILE_SOURCE + sessionPath) as any;
        const meta = db
          .prepare("SELECT status FROM meta WHERE id=1")
          .get() as any;
        db.close();
        pending =
          !!row &&
          row.pending > row.completed &&
          meta.status === "unsupported-session";
      } catch {}
      if (!pending) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(pending, true);
    assert.equal(providerCalls, 0);
    await handlers.get("session_shutdown")!({}, ctx);
    let calls = 0;
    resumed = new MemoryScheduler({
      project: cwd,
      runtimeDir: runtime,
      sessionDir: defaultDir,
      retryMs: 10,
      cooldownMs: 0,
      work: async () => {
        calls++;
        return { status: "done" };
      },
    });
    resumed.start();
    for (
      let i = 0;
      i < 100 && resumed.status().status !== "unsupported-session";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(resumed.status().status, "unsupported-session");
    assert.equal(resumed.status().pending, 1);
    assert.equal(resumed.status().unsupportedSessions, 1);
    assert.equal(calls, 0);
  } finally {
    await resumed?.shutdown();
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
