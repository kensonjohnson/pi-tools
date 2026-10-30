import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";
import { MemoryScheduler } from "./scheduler.ts";

test("review controls work headlessly; UI feedback clears and reports persist", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-review-ui-")),
    agent = await mkdtemp(join(tmpdir(), "memory-agent-"));
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  let sequence = 0;
  const timers = new Map<number, () => void>();
  const fakeSet = ((fn: () => void) => {
    const id = ++sequence;
    timers.set(id, fn);
    return { id, unref() {} };
  }) as any;
  const fakeClear = ((timer: any) => {
    if (timer) timers.delete(timer.id);
  }) as any;
  try {
    await mkdir(join(cwd, ".pi", "memory"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "pi-tools.json"),
      JSON.stringify({
        version: 1,
        extensions: {
          memory: {
            historyReview: { enabled: false },
            models: { reviewer: "p/model" },
          },
        },
      }),
    );
    const tools = new Map<string, any>(),
      handlers = new Map<string, Function>(),
      commands = new Map<string, any>();
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
      registerCommand(name: string, definition: any) {
        commands.set(name, definition);
      },
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    };
    extension(pi);
    let calls = 0;
    const statuses: Array<string | undefined> = [];
    const notices: string[] = [];
    const ctx: any = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      sessionManager: { getSessionDir: () => cwd },
      ui: {
        setStatus(_key: string, value: string | undefined) {
          statuses.push(value);
        },
        notify(message: string) {
          notices.push(message);
        },
      },
      modelRegistry: {
        find: () => ({ provider: "p", id: "model", input: ["text"] }),
        getAvailable: () => [],
        getApiKeyAndHeaders: async () => ({ ok: true }),
        complete: async () => ({
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: ++calls % 2 ? '{"paths":[]}' : '{"action":"no_change"}',
            },
          ],
        }),
      },
    };
    await handlers.get("session_start")!({}, ctx);
    const tool = tools.get("memory_review");
    assert.ok(tool);
    const status = await tool.execute(
      "",
      { action: "status" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(status.details.report.historyEnabled, false);
    const rejected = await tools
      .get("memory_consolidate")
      .execute("", { since: "2025" }, undefined, undefined, ctx);
    assert.match(rejected.content[0].text, /no longer supported/);
    assert.equal(calls, 0);
    globalThis.setTimeout = fakeSet;
    globalThis.clearTimeout = fakeClear;
    const result = await tools
      .get("memory_consolidate")
      .execute("", {}, undefined, undefined, ctx);
    assert.match(result.content[0].text, /review unresolved/i);
    assert.equal(calls, 2);
    assert.ok(statuses.some((x) => x?.includes("manual-running")));
    assert.ok(statuses.some((x) => x?.includes("unresolved")));
    assert.equal(timers.size, 1);
    [...timers.values()][0]();
    assert.equal(statuses.at(-1), undefined);
    const report = await tool.execute(
      "",
      { action: "status" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(report.details.report.events[0].mode, "manual");
    assert.equal(report.details.report.events[0].status, "unresolved");
    await commands.get("memory-review").handler("status", ctx);
    assert.match(notices.at(-1)!, /Memory review report/);
    await tool.execute("", { action: "cancel" }, undefined, undefined, ctx);
    assert.equal(
      (await tool.execute("", { action: "status" }, undefined, undefined, ctx))
        .details.report.status.paused,
      true,
    );
    await tool.execute("", { action: "resume" }, undefined, undefined, ctx);
    assert.equal(
      (await tool.execute("", { action: "status" }, undefined, undefined, ctx))
        .details.report.status.paused,
      false,
    );
    ctx.hasUI = false;
    await tool.execute("", { action: "full" }, undefined, undefined, ctx);
    assert.equal(calls, 4);
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
    await handlers.get("session_shutdown")!({}, ctx);
    const tools2 = new Map<string, any>(),
      handlers2 = new Map<string, Function>();
    extension({
      ...pi,
      on(name: string, cb: Function) {
        handlers2.set(name, cb);
      },
      registerTool(tool: any) {
        tools2.set(tool.name, tool);
      },
    });
    const restored = await tools2
      .get("memory_review")
      .execute("", { action: "status" }, undefined, undefined, ctx);
    assert.equal(restored.details.report.events[0].status, "unresolved");
    await handlers2.get("session_shutdown")!({}, ctx);
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});

test("review status and full review report untrusted, uninitialized and unconfigured states", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-review-ui-")),
    agent = await mkdtemp(join(tmpdir(), "memory-agent-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    const tools = new Map<string, any>();
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
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
    };
    extension(pi);
    const ctx: any = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => false,
      sessionManager: { getSessionDir: () => cwd },
      modelRegistry: { getAvailable: () => [] },
    };
    const tool = tools.get("memory_review");
    assert.match(
      (await tool.execute("", { action: "status" }, undefined, undefined, ctx))
        .content[0].text,
      /trusted/,
    );
    ctx.isProjectTrusted = () => true;
    assert.match(
      (await tool.execute("", { action: "status" }, undefined, undefined, ctx))
        .content[0].text,
      /not enabled/,
    );
    await mkdir(join(cwd, ".pi", "memory"), { recursive: true });
    assert.match(
      (await tool.execute("", { action: "full" }, undefined, undefined, ctx))
        .content[0].text,
      /explicitly configured/,
    );
    const report = await tool.execute(
      "",
      { action: "status" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(report.details.report.events[0].status, "error");
    const other = new MemoryScheduler({
      project: cwd,
      runtimeDir: join(cwd, ".pi", "memory", ".runtime", "review-scheduler"),
      sessionDir: cwd,
      automatic: false,
      work: async () => ({ status: "done" }),
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = other.runManual(async () => {
      await held;
      return { status: "done" };
    });
    try {
      const busy = await tool.execute(
        "",
        { action: "full" },
        undefined,
        undefined,
        ctx,
      );
      assert.match(busy.content[0].text, /already active.*wait/i);
      assert.equal(busy.details.active, true);
      assert.notEqual(busy.details.failed, true);
      const during = await tool.execute(
        "",
        { action: "status" },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(during.details.report.events[0].status, "error");
    } finally {
      release();
      await running;
    }
    try {
      await other.waitForIdle();
      await other.runManual(async () => ({
        status: "unresolved",
        detail:
          "Review found an unresolved evidence or authority conflict; inspect before resuming.",
      }));
      await other.waitForIdle();
      const unresolved = await tool.execute(
        "",
        { action: "status" },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(unresolved.details.report.status.paused, false);
      assert.match(
        unresolved.content[0].text,
        /Run \/memory-review full again to retry/,
      );
      assert.doesNotMatch(unresolved.content[0].text, /before resuming/);
      const retry = await tool.execute(
        "",
        { action: "full" },
        undefined,
        undefined,
        ctx,
      );
      assert.match(retry.content[0].text, /explicitly configured/);
      assert.doesNotMatch(retry.content[0].text, /paused|resume/);
    } finally {
      await other.shutdown();
    }
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
