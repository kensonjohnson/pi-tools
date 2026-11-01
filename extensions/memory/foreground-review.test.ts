import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
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
    for (const args of [
      "full",
      "status",
      "cancel",
      "resume",
      "--since 2025-01-01",
    ]) {
      await commands.get("memory-review").handler(args, ctx);
    }
    assert.deepEqual(sent, []);
    assert.equal(notices.length, 5);
    assert.ok(
      notices.every((notice) => notice.includes("Usage: /memory-review")),
    );
    assert.equal(tools.has("memory_review"), false);
    assert.equal(tools.has("memory_learn"), false);
    const consolidate = tools.get("memory_consolidate");
    assert.ok(Value.Check(consolidate.parameters, {}));
    assert.equal(
      Value.Check(consolidate.parameters, { since: "2025-01-01" }),
      false,
    );
    assert.equal(
      Value.Check(consolidate.parameters, { action: "full" }),
      false,
    );
    await commands.get("memory-review").handler("", ctx);
    assert.deepEqual(sent, [FOREGROUND_REVIEW_PROMPT]);
    assert.match(
      FOREGROUND_REVIEW_PROMPT,
      /directly verified absent, remove the memory/,
    );
    assert.match(
      FOREGROUND_REVIEW_PROMPT,
      /rather than retaining a conditional or historical substitute/,
    );
    const result = await consolidate.execute("", {}, undefined, undefined, ctx);
    assert.equal(result.content[0].text, FOREGROUND_REVIEW_PROMPT);
    assert.equal(result.details.foreground, true);
    await commands
      .get("memory-review")
      .handler("", { ...ctx, isIdle: () => false });
    await commands
      .get("memory-review")
      .handler("", { ...ctx, isProjectTrusted: () => false });
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
