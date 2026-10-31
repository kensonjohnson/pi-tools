import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import extension from "./index.ts";

test("configured background review repairs duplicates and resumes activity", async () => {
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
    const secondRow = JSON.stringify({
      id: "duplicate",
      created: "2026-01-01",
      content: "second fact",
    });
    await writeFile(join(memory, "knowledge.ndjson"), `${row}\n${secondRow}\n`);
    await mkdir(join(cwd, "sessions"));
    await writeFile(
      join(cwd, "sessions", "s.jsonl"),
      [
        { type: "session", version: 3, id: "s", cwd },
        {
          type: "message",
          id: "1",
          parentId: null,
          message: {
            role: "user",
            content: "Remember a relevant project fact.",
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    let modelCalls = 0;
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
      modelRegistry: {
        find: () => ({ provider: "p", id: "m", input: ["text"] }),
        getAvailable: () => [],
        getApiKeyAndHeaders: async () => ({ ok: true }),
        complete: async (_model: unknown, request: any) => {
          const rows = (
            await readFile(join(memory, "knowledge.ndjson"), "utf8")
          )
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.notEqual(rows[0].id, rows[1].id);
          modelCalls++;
          return {
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: request.systemPrompt.includes("Select evidence requests")
                  ? '{"paths":[]}'
                  : '{"action":"no_change","evidenceSufficient":true,"reason":"Session reviewed."}',
              },
            ],
          };
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
      const schedulerDb = join(
        memory,
        ".runtime",
        "review-scheduler",
        "scheduler.sqlite",
      );
      for (let i = 0; i < 100 && !existsSync(schedulerDb); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const db = new Database(schedulerDb, { fileMustExist: true });
      db.prepare(
        "INSERT INTO manual_cursor(id,offset,snapshot) VALUES(1,?,?)",
      ).run(1, "a".repeat(64));
      db.close();
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
      if (modelCalls >= 3 && status.status === "done") break;
    }
    assert.equal(status.paused, false);
    assert.equal(modelCalls, 3);
    assert.equal(status.status, "done");
    assert.equal(status.manualContinuation, undefined);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /Reassigned 1 duplicate/);
    assert.match(
      (await handlers.get("before_agent_start")!({}, ctx)).message.content,
      /fact/,
    );
    const report = await tools
      .get("memory_review")
      .execute("", { action: "status" }, undefined, undefined, ctx);
    assert.match(
      JSON.stringify(report.details.report.events),
      /Reassigned 1 duplicate/,
    );
    assert.equal(notices.length, 1);
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
