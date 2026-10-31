import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";
import { MemoryManager } from "./core.ts";

test("foreground triggers guard writes until settlement and failed dispatch disarms", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "foreground-guards-"));
  const ready = MemoryManager.prototype.isReady;
  const update = MemoryManager.prototype.update;
  const forget = MemoryManager.prototype.forget;
  const tools = new Map<string, any>(),
    commands = new Map<string, any>(),
    hooks = new Map<string, any>();
  let failDispatch = false;
  try {
    MemoryManager.prototype.isReady = async () => true;
    MemoryManager.prototype.update = async () => null;
    MemoryManager.prototype.forget = async () => null;
    extension({
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      on(name: string, handler: any) {
        hooks.set(name, handler);
      },
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: any) {
        commands.set(name, command);
      },
      sendUserMessage() {
        if (failDispatch) throw new Error("dispatch failed");
      },
    } as any);
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      isIdle: () => true,
      hasUI: false,
    };
    const call = (name: string, params: object) =>
      tools.get(name).execute("", params, undefined, undefined, ctx);
    async function guarded() {
      await assert.rejects(
        call("memory_update", { id: "x", content: "new" }),
        /requires expectedContent/,
      );
      await assert.rejects(
        call("memory_forget", { id: "x", expectedContent: "old" }),
        /only removes duplicates/,
      );
    }
    await commands.get("memory-review").handler("full", ctx);
    await guarded();
    hooks.get("agent_settled")();
    await call("memory_update", { id: "x", content: "new" });
    await call("memory_forget", { id: "x" });
    for (const [name, params] of [
      ["memory_review", { action: "full" }],
      ["memory_consolidate", {}],
    ] as const) {
      await call(name, params);
      await guarded();
      hooks.get("agent_settled")();
    }
    hooks.get("message_end")({
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "memory_review",
            arguments: { action: "full" },
          },
        ],
      },
    });
    await guarded();
    hooks.get("agent_settled")();
    failDispatch = true;
    await assert.rejects(
      commands.get("memory-review").handler("full", ctx),
      /dispatch failed/,
    );
    await call("memory_update", { id: "x", content: "new" });
  } finally {
    MemoryManager.prototype.isReady = ready;
    MemoryManager.prototype.update = update;
    MemoryManager.prototype.forget = forget;
    await rm(cwd, { recursive: true, force: true });
  }
});
