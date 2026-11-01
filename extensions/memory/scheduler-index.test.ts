import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "./index.ts";

test("session lifecycle never dispatches background review or tracks activity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "scheduler-index-"));
  const agent = await mkdtemp(join(tmpdir(), "scheduler-agent-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    await mkdir(join(cwd, ".pi", "memory"), { recursive: true });
    let calls = 0;
    const ctx: any = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionDir: () => join(cwd, "sessions"),
        getSessionFile: () => join(cwd, "sessions", "one.jsonl"),
      },
      modelRegistry: {
        find() {
          calls++;
        },
        getAvailable() {
          return [];
        },
      },
    };
    for (const scenario of [
      {
        values: {
          historyReview: { enabled: false },
          models: { reviewer: "p/model" },
        },
        trusted: true,
        worker: false,
      },
      {
        values: {},
        trusted: true,
        worker: false,
      },
      {
        values: {
          historyReview: {
            enabled: true,
            debounceSeconds: 0,
            cooldownSeconds: 0,
          },
          models: { reviewer: "p/model" },
        },
        trusted: true,
        worker: false,
      },
      {
        values: {
          historyReview: { enabled: true },
          models: { reviewer: "p/model" },
        },
        trusted: false,
        worker: false,
      },
      {
        values: {
          historyReview: { enabled: true },
          models: { reviewer: "p/model" },
        },
        trusted: true,
        worker: true,
      },
    ]) {
      ctx.isProjectTrusted = () => scenario.trusted;
      ctx.sessionManager.getSessionDir = () =>
        scenario.worker
          ? join(cwd, "tmp", "subagents", "worker", "session")
          : join(cwd, "sessions");
      await writeFile(
        join(cwd, ".pi", "pi-tools.json"),
        JSON.stringify({ version: 1, extensions: { memory: scenario.values } }),
      );
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
      await handlers.get("agent_settled")!({}, ctx);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await handlers.get("session_shutdown")!({}, ctx);
    }
    assert.equal(calls, 0);
    await assert.rejects(
      import("node:fs/promises").then(({ access }) =>
        access(join(cwd, ".pi", "memory", ".runtime", "review-scheduler")),
      ),
      { code: "ENOENT" },
    );
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
