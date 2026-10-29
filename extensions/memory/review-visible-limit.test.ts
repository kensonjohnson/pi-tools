import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "./index.ts";
import { MemoryScheduler } from "./scheduler.ts";

test("visible review report counts changes omitted at storage and display limits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-display-")),
    agent = await mkdtemp(join(tmpdir(), "review-agent-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    await mkdir(join(cwd, ".pi", "memory"), { recursive: true });
    const scheduler = new MemoryScheduler({
      project: cwd,
      runtimeDir: join(cwd, ".pi", "memory", ".runtime", "review-scheduler"),
      sessionDir: cwd,
      automatic: false,
      work: async () => ({ status: "pending" }),
    });
    await scheduler.runManual(async () => ({
      status: "done",
      changes: Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        detail: `change ${i}`,
      })),
    }));
    await scheduler.shutdown();
    const tools = new Map<string, any>(),
      handlers = new Map<string, Function>();
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
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
    };
    extension(pi);
    const ctx: any = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: { getSessionDir: () => cwd },
      modelRegistry: { getAvailable: () => [] },
    };
    const report = await tools
      .get("memory_review")
      .execute("", { action: "status" }, undefined, undefined, ctx);
    const event = report.details.report.events[0];
    assert.equal(event.changesTotal, 20);
    assert.equal(event.changes.length, 5);
    assert.equal(event.changesOmitted, 15);
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
