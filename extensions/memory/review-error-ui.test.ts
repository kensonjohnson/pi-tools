import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";

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
    const duplicate = await tool.execute(
      "",
      { action: "full" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      duplicate.content[0].text,
      /Duplicate memory IDs.*assign unique IDs/,
    );
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
    assert.match(duplicateReport.content[0].text, /Duplicate memory IDs/);
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
