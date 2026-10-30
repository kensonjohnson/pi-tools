import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";
import { MemoryManager, NdjsonMemoryStore } from "./core.ts";

test("manual review reports safe model failures in command, tool and status", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-review-error-"));
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>(),
    commands = new Map<string, any>();
  try {
    await mkdir(join(cwd, ".pi", "memory"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "pi-tools.json"),
      JSON.stringify({
        version: 1,
        extensions: { memory: { models: { reviewer: "p/model" } } },
      }),
    );
    extension({
      events: { on: () => () => {}, emit() {} },
      on: (n: string, f: Function) => handlers.set(n, f),
      registerTool: (t: any) => tools.set(t.name, t),
      registerCommand: (n: string, c: any) => commands.set(n, c),
      getActiveTools: () => [],
      setActiveTools() {},
    } as any);
    const notices: string[] = [];
    const ctx: any = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      sessionManager: { getSessionDir: () => cwd },
      ui: { notify: (s: string) => notices.push(s), setStatus() {} },
      modelRegistry: {
        find: () => ({ provider: "p", id: "model", input: ["text"] }),
        getAvailable: () => [],
        getApiKeyAndHeaders: async () => ({ ok: true }),
        complete: async () => {
          throw new Error("Bearer SECRET private@example.com /private/path");
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
    assert.match(result.content[0].text, /reviewer model configuration/);
    assert.doesNotMatch(
      JSON.stringify(result),
      /SECRET|private@example|\/private\/path/,
    );
    const report = await tool.execute(
      "",
      { action: "status" },
      undefined,
      undefined,
      ctx,
    );
    assert.doesNotMatch(
      JSON.stringify(report),
      /SECRET|private@example|\/private\/path/,
    );
    await commands.get("memory-review").handler("full", ctx);
    for (let i = 0; i < 100 && !notices.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(notices.at(-1)!, /reviewer model configuration/);
    assert.doesNotMatch(
      notices.at(-1)!,
      /SECRET|private@example|\/private\/path/,
    );
    const row = JSON.stringify({
      id: "private@example.com",
      created: "2026-01-01",
      content: "private fact",
    });
    await writeFile(
      join(cwd, ".pi", "memory", "knowledge.ndjson"),
      `${row}\n${row}\n`,
    );
    ctx.hasUI = false;
    const db = new Database(
      join(
        cwd,
        ".pi",
        "memory",
        ".runtime",
        "review-scheduler",
        "scheduler.sqlite",
      ),
    );
    db.prepare(
      "INSERT INTO manual_cursor(id,offset,snapshot) VALUES(1,?,?)",
    ).run(1, "a".repeat(64));
    db.close();
    let modelCalls = 0;
    ctx.modelRegistry.complete = async () => {
      const rows = (
        await readFile(join(cwd, ".pi", "memory", "knowledge.ndjson"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.notEqual(rows[0].id, rows[1].id);
      assert.deepEqual(
        rows.map(({ id, ...rest }) => rest),
        [
          { created: "2026-01-01", content: "private fact" },
          { created: "2026-01-01", content: "private fact" },
        ],
      );
      return {
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: ++modelCalls % 2 ? '{"paths":[]}' : '{"action":"no_change"}',
          },
        ],
      };
    };
    const duplicate = await tool.execute(
      "",
      { action: "full" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(duplicate.content[0].text, /Reassigned 1 duplicate memory ID/);
    assert.doesNotMatch(
      JSON.stringify(duplicate),
      /private@example|private fact/,
    );
    const duplicateReport = await tool.execute(
      "",
      { action: "status" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      duplicateReport.content[0].text,
      /Reassigned 1 duplicate memory ID/,
    );
    assert.equal(modelCalls, 2);
    assert.equal(
      duplicateReport.details.report.status.manualContinuation,
      undefined,
    );
    // A different process can finish or recover a repair before this review.
    await writeFile(
      join(cwd, ".pi", "memory", "knowledge.ndjson"),
      `${row}\n${row}\n`,
    );
    const external = new NdjsonMemoryStore(
      cwd,
      ".pi/memory",
      undefined,
      async (phase) => {
        if (phase === "journal") throw new Error("interrupted");
      },
    );
    await assert.rejects(external.resolveDuplicateIds(), /interrupted/);
    const db2 = new Database(
      join(
        cwd,
        ".pi",
        "memory",
        ".runtime",
        "review-scheduler",
        "scheduler.sqlite",
      ),
    );
    db2
      .prepare("INSERT INTO manual_cursor(id,offset,snapshot) VALUES(1,?,?)")
      .run(1, "b".repeat(64));
    db2.close();
    const observed = await tool.execute(
      "",
      { action: "full" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(observed.content[0].text, /Reassigned 1 duplicate memory ID/);
    const receipts = await new MemoryManager(cwd).listDuplicateIdResolutions();
    assert.equal(receipts.length, 2);
    assert.ok(
      receipts.some((receipt) =>
        observed.content[0].text.includes(receipt.changes[0].newId),
      ),
    );
    const repeated = await tool.execute(
      "",
      { action: "full" },
      undefined,
      undefined,
      ctx,
    );
    assert.doesNotMatch(repeated.content[0].text, /Reassigned/);
    assert.equal(modelCalls, 6);
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
