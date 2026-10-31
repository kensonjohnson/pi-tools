import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";
import { MemoryManager } from "./core.ts";
import { FOREGROUND_REVIEW_PROMPT } from "./foreground-review.ts";

test("foreground entry points use the current agent and never start the legacy reviewer", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-foreground-"));
  const original = MemoryManager.prototype.isReady;
  const tools = new Map<string, any>(),
    commands = new Map<string, any>();
  const sent: string[] = [],
    notices: string[] = [];
  try {
    MemoryManager.prototype.isReady = async () => true;
    extension({
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      on() {},
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: any) {
        commands.set(name, command);
      },
      sendUserMessage(message: string) {
        sent.push(message);
      },
    } as any);
    const ctx = {
      cwd: root,
      isProjectTrusted: () => true,
      isIdle: () => true,
      hasUI: true,
      ui: { notify: (text: string) => notices.push(text) },
    };
    await commands.get("memory-review").handler("full", ctx);
    assert.deepEqual(sent, [FOREGROUND_REVIEW_PROMPT]);
    for (const [name, params] of [
      ["memory_review", { action: "full" }],
      ["memory_consolidate", {}],
    ] as const) {
      const result = await tools
        .get(name)
        .execute("", params, undefined, undefined, ctx);
      assert.equal(result.content[0].text, FOREGROUND_REVIEW_PROMPT);
      assert.equal(result.details.foreground, true);
    }
    const resume = await tools
      .get("memory_review")
      .execute("", { action: "resume" }, undefined, undefined, ctx);
    assert.match(resume.content[0].text, /no foreground progress/i);
    await commands
      .get("memory-review")
      .handler("full", { ...ctx, isIdle: () => false });
    await commands
      .get("memory-review")
      .handler("full", { ...ctx, isProjectTrusted: () => false });
    assert.equal(sent.length, 1);
    assert.match(notices.join(" "), /busy/i);
    assert.match(notices.join(" "), /trust/i);
    const denied = await tools
      .get("memory_consolidate")
      .execute("", {}, undefined, undefined, {
        ...ctx,
        isProjectTrusted: () => false,
      });
    assert.equal(denied.details.failed, true);
  } finally {
    MemoryManager.prototype.isReady = original;
    await rm(root, { recursive: true, force: true });
  }
});
