import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryManager } from "./core.ts";
import extension from "./index.ts";

type RegisteredTool = {
  name: string;
  execute?: (...args: any[]) => Promise<any>;
  renderResult?: (
    result: any,
    options: any,
    theme: any,
  ) => {
    render(width: number): string[];
  };
};

function rememberTool(): RegisteredTool {
  const tools: RegisteredTool[] = [];
  const pi = {
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on() {},
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  };

  extension(pi as unknown as ExtensionAPI);
  const tool = tools.find((candidate) => candidate.name === "memory_remember");
  assert.ok(tool?.execute);
  assert.ok(tool?.renderResult);
  return tool;
}

const plainTheme = {
  fg(_color: string, text: string) {
    return text;
  },
};

test("memory_remember omits opaque IDs from confirmations and TUI output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-renderer-"));
  const id = "019f733a-329c-72d9-9c86-770704954eaa";
  const originalIsReady = MemoryManager.prototype.isReady;
  const originalRemember = MemoryManager.prototype.remember;
  let calls = 0;

  MemoryManager.prototype.isReady = async () => true;
  MemoryManager.prototype.remember = async (category, content) => ({
    memory: { category, content, id, created: "2026-07-18T03:17:01.724Z" },
    created: ++calls === 1,
  });

  try {
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(
      join(root, ".pi", "pi-tools.json"),
      JSON.stringify({
        version: 1,
        extensions: { memory: { enabled: true } },
      }),
    );
    const tool = rememberTool();
    const context = { cwd: root, isProjectTrusted: () => true };
    const results = await Promise.all([
      tool.execute!(
        "",
        { category: "decisions", content: "Keep it terse." },
        undefined,
        undefined,
        context,
      ),
      tool.execute!(
        "",
        { category: "decisions", content: "Keep it terse." },
        undefined,
        undefined,
        context,
      ),
    ]);

    assert.deepEqual(results.map((result) => result.content[0].text).sort(), [
      "Matching decisions memory already exists.",
      "Stored decisions memory.",
    ]);

    for (const result of results) {
      const confirmation = result.content[0].text;
      const rendered = tool.renderResult!(result, {}, plainTheme)
        .render(120)
        .join("\n");

      assert.doesNotMatch(confirmation, new RegExp(id));
      assert.equal(result.details.id, id);
      assert.match(rendered, /decisions memory/);
      assert.match(rendered, /Keep it terse\./);
      assert.doesNotMatch(rendered, new RegExp(id));
    }
  } finally {
    MemoryManager.prototype.isReady = originalIsReady;
    MemoryManager.prototype.remember = originalRemember;
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back to raw text when a result has no memory-renderer details", () => {
  const renderer = rememberTool().renderResult!;
  const rendered = renderer(
    {
      content: [{ type: "text", text: "Memory tracking is not enabled." }],
      details: { enabled: false },
    },
    {},
    plainTheme,
  )
    .render(120)
    .join("\n");

  assert.equal(rendered.trimEnd(), "Memory tracking is not enabled.");
});
