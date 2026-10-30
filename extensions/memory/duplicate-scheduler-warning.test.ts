import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import extension from "./index.ts";

test("configured background review retains activity while duplicates exist", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-scheduler-conflict-"));
  try {
    const memory = join(cwd, ".pi", "memory");
    await mkdir(memory, { recursive: true });
    await writeFile(
      join(cwd, ".pi", "pi-tools.json"),
      JSON.stringify({
        version: 1,
        extensions: {
          memory: {
            historyReview: {
              enabled: true,
              debounceSeconds: 0,
              cooldownSeconds: 1,
            },
            models: { reviewer: "p/m" },
          },
        },
      }),
    );
    const row = JSON.stringify({
      id: "duplicate",
      created: "2026-01-01",
      content: "fact",
    });
    await writeFile(join(memory, "knowledge.ndjson"), `${row}\n${row}\n`);
    const handlers = new Map<string, Function>();
    const tools = new Map<string, any>();
    const notices: string[] = [];
    extension({
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      on(name: string, fn: Function) {
        handlers.set(name, fn);
      },
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    } as any);
    const ctx: any = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionId: () => "s",
        getSessionFile: () => join(cwd, "sessions", "s.jsonl"),
      },
      ui: {
        notify(message: string) {
          notices.push(message);
        },
      },
    };
    const locker = new Database(join(memory, "write-lock.db"));
    locker.exec("BEGIN IMMEDIATE");
    try {
      await Promise.race([
        handlers.get("session_start")!({}, ctx),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("session_start waited on the memory lock")),
            500,
          ),
        ),
      ]);
      await handlers.get("agent_settled")!({}, ctx);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
    assert.equal(notices.length, 0);
    let status: any;
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = (
        await tools
          .get("memory_review")
          .execute("", { action: "status" }, undefined, undefined, ctx)
      ).details.report.status;
      if (status.pending > 0 && status.status === "pending") break;
    }
    assert.ok(status.pending > 0);
    assert.equal(status.status, "pending");
    assert.equal(status.paused, false);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /duplicate/);
    assert.match(
      (await handlers.get("before_agent_start")!({}, ctx)).message.content,
      /fact/,
    );
    assert.equal(notices.length, 1);
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
