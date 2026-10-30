import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";

test("malformed model diagnostics are shown in tool, status and command without admitting injected errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-malformed-ui-"));
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
    let content = "";
    let injected: string | undefined;
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
          if (injected) throw new Error(injected);
          return {
            stopReason: "stop",
            content: [{ type: "text", text: content }],
          };
        },
      },
    };
    const tool = tools.get("memory_review");
    const empty = await tool.execute(
      "",
      { action: "status" },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(empty.details.report.events, []);
    assert.match(empty.content[0].text, /Recent runs[\s\S]*None\./);
    await commands.get("memory-review").handler("status", ctx);
    assert.match(notices.at(-1)!, /Recent runs[\s\S]*None\./);
    for (const [value, shape] of [
      ["", "empty text"],
      ["```json\n{broken}\n```", "invalid fenced JSON"],
      ["prose {broken}", "invalid JSON or unsupported wrapper"],
    ]) {
      content = value;
      const expected = `review model returned malformed JSON (${shape}; ${Buffer.byteLength(value)} text bytes)`;
      const result = await tool.execute(
        "",
        { action: "full" },
        undefined,
        undefined,
        ctx,
      );
      assert.ok(result.content[0].text.includes(expected));
      const report = await tool.execute(
        "",
        { action: "status" },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(report.details.report.events[0].detail, expected);
      const previous = notices.length;
      await commands.get("memory-review").handler("full", ctx);
      for (let i = 0; i < 100 && notices.length === previous; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(notices.at(-1)?.includes(expected));
    }
    // Valid JSON can still fail the evidence request schema. No provider is called.
    injected = undefined;
    content = JSON.stringify({ paths: [42] });
    const diagnostic =
      "Reviewer returned invalid evidence requests. Retry or use a different reviewer model.";
    const invalid = await tool.execute(
      "",
      { action: "full" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(invalid.content[0].text, /invalid evidence requests/);
    const status = await tool.execute(
      "",
      { action: "status" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(status.details.report.events[0].detail, diagnostic);
    assert.ok(status.content[0].text.includes(diagnostic));
    await commands.get("memory-review").handler("status", ctx);
    assert.ok(notices.at(-1)?.includes(diagnostic));
    const previous = notices.length;
    await commands.get("memory-review").handler("full", ctx);
    for (let i = 0; i < 100 && notices.length === previous; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(notices.at(-1)?.includes(diagnostic));

    for (const [value, expected] of [
      ["malformed reviewer response", "required schema"],
      ["evidence byte limit reached", "Evidence byte limit reached"],
      [
        "review snapshot changed or is missing; restart at zero",
        "Restart the full review from zero",
      ],
      [
        "review model must be explicitly configured as provider/model",
        "Configure the reviewer model as provider/model",
      ],
    ]) {
      injected = value;
      const result = await tool.execute(
        "",
        { action: "full" },
        undefined,
        undefined,
        ctx,
      );
      assert.ok(result.content[0].text.includes(expected));
      const report = await tool.execute(
        "",
        { action: "status" },
        undefined,
        undefined,
        ctx,
      );
      assert.ok(report.content[0].text.includes(expected));
    }
    for (const value of [
      "malformed reviewer evidence requests\nSECRET /private/path",
      "malformed reviewer response SECRET /private/path",
      "evidence byte limit reached\nSECRET /private/path",
      "review model returned malformed JSON (empty text; 0 text bytes)\nSECRET",
      "review model returned malformed JSON (empty text; 0 text bytes)\n",
      "review model returned malformed JSON (SECRET; 1 text bytes)",
      "review model returned malformed JSON (empty text; 123456 text bytes)",
    ]) {
      injected = value;
      const result = await tool.execute(
        "",
        { action: "full" },
        undefined,
        undefined,
        ctx,
      );
      assert.match(
        result.content[0].text,
        /Check the reviewer model configuration/,
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /SECRET|123456|empty text|\/private\/path/,
      );
      const report = await tool.execute(
        "",
        { action: "status" },
        undefined,
        undefined,
        ctx,
      );
      assert.match(
        report.details.report.events[0].detail,
        /Check the reviewer model configuration/,
      );
      const previous = notices.length;
      await commands.get("memory-review").handler("full", ctx);
      for (let i = 0; i < 100 && notices.length === previous; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(notices.at(-1)!, /Check the reviewer model configuration/);
      assert.doesNotMatch(
        notices.at(-1)!,
        /SECRET|123456|empty text|\/private\/path/,
      );
    }
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
