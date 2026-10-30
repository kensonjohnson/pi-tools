import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import extension from "./index.ts";

test("duplicate repair conflict pauses review without provider access or leaking error data", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-repair-conflict-"));
  const original = MemoryManager.prototype.resolveDuplicateIds;
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>();
  try {
    await mkdir(join(cwd, ".pi", "memory"), { recursive: true });
    MemoryManager.prototype.resolveDuplicateIds = async () => {
      throw new Error("private@example.com SECRET");
    };
    extension({
      events: { on: () => () => {}, emit() {} },
      on: (n: string, f: Function) => handlers.set(n, f),
      registerTool: (t: any) => tools.set(t.name, t),
      getActiveTools: () => [],
      setActiveTools() {},
    } as any);
    let calls = 0;
    const ctx: any = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: { getSessionDir: () => cwd },
      modelRegistry: {
        find: () => {
          calls++;
        },
      },
    };
    const tool = tools.get("memory_review");
    const result = await tool.execute(
      "",
      { action: "full" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.details.result.status, "uncertain");
    assert.match(result.content[0].text, /repair may be incomplete/);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|private@example/);
    const status = await tool.execute(
      "",
      { action: "status" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(status.details.report.status.paused, true);
    assert.equal(calls, 0);
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    MemoryManager.prototype.resolveDuplicateIds = original;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cancellation while waiting for the memory lock never starts a repair", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-repair-lock-cancel-"));
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>();
  let locker: Database.Database | undefined;
  try {
    const memory = join(cwd, ".pi", "memory");
    await mkdir(memory, { recursive: true });
    extension({
      events: { on: () => () => {}, emit() {} },
      on: (n: string, f: Function) => handlers.set(n, f),
      registerTool: (t: any) => tools.set(t.name, t),
      getActiveTools: () => [],
      setActiveTools() {},
    } as any);
    let calls = 0;
    const ctx: any = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: { getSessionDir: () => cwd },
      modelRegistry: {
        find: () => {
          calls++;
        },
      },
    };
    const tool = tools.get("memory_review");
    await tool.execute("", { action: "full" }, undefined, undefined, ctx);
    calls = 0;
    const row = JSON.stringify({
      id: "duplicate",
      created: "2026-01-01",
      content: "fact",
    });
    const contents = `${row}\n${row}\n`;
    await writeFile(join(memory, "knowledge.ndjson"), contents);
    locker = new Database(join(memory, "write-lock.db"));
    locker.exec("BEGIN IMMEDIATE");
    const controller = new AbortController();
    const running = tool.execute(
      "",
      { action: "full" },
      controller.signal,
      undefined,
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 70));
    controller.abort();
    const result = await Promise.race([
      running,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("cancel did not settle under lock")),
          1000,
        ),
      ),
    ]);
    assert.equal(result.details.result.status, "uncertain");
    assert.equal(
      await readFile(join(memory, "knowledge.ndjson"), "utf8"),
      contents,
    );
    assert.equal(calls, 0);
    locker.exec("ROLLBACK");
    locker.close();
    locker = undefined;
    assert.equal(
      (await new MemoryManager(cwd).listDuplicateIdResolutions()).length,
      0,
    );
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    if (locker) {
      locker.exec("ROLLBACK");
      locker.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cancellation after repair reports uncertainty and preserves the receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-repair-cancel-"));
  const original = MemoryManager.prototype.resolveDuplicateIds;
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>();
  const controller = new AbortController();
  try {
    await mkdir(join(cwd, ".pi", "memory"), { recursive: true });
    const row = JSON.stringify({
      id: "duplicate",
      created: "2026-01-01",
      content: "private fact",
    });
    await writeFile(
      join(cwd, ".pi", "memory", "knowledge.ndjson"),
      `${row}\n${row}\n`,
    );
    MemoryManager.prototype.resolveDuplicateIds = async function () {
      const result = await original.call(this);
      controller.abort();
      return result;
    };
    extension({
      events: { on: () => () => {}, emit() {} },
      on: (n: string, f: Function) => handlers.set(n, f),
      registerTool: (t: any) => tools.set(t.name, t),
      getActiveTools: () => [],
      setActiveTools() {},
    } as any);
    let calls = 0;
    const ctx: any = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: { getSessionDir: () => cwd },
      modelRegistry: {
        find: () => {
          calls++;
        },
      },
    };
    const tool = tools.get("memory_review");
    const result = await tool.execute(
      "",
      { action: "full" },
      controller.signal,
      undefined,
      ctx,
    );
    assert.equal(result.details.result.status, "uncertain");
    assert.match(result.content[0].text, /Reassigned 1 duplicate/);
    assert.doesNotMatch(JSON.stringify(result), /private fact/);
    assert.equal(calls, 0);
    assert.equal(
      (await new MemoryManager(cwd).listDuplicateIdResolutions()).length,
      1,
    );
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    MemoryManager.prototype.resolveDuplicateIds = original;
    await rm(cwd, { recursive: true, force: true });
  }
});
