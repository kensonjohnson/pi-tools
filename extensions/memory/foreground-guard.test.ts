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
  const capture = MemoryManager.prototype.captureWritePrecondition;
  const tools = new Map<string, any>(),
    commands = new Map<string, any>(),
    hooks = new Map<string, any>();
  let failDispatch = false;
  try {
    MemoryManager.prototype.isReady = async () => true;
    MemoryManager.prototype.update = async () => null;
    MemoryManager.prototype.forget = async () => null;
    MemoryManager.prototype.captureWritePrecondition = async (id) => ({
      id,
      category: "knowledge",
      rawLine: JSON.stringify({ id, content: "old" }),
    });
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
        call("memory_forget", { id: "x" }),
        /requires expectedContent/,
      );
      await call("memory_forget", { id: "x", expectedContent: "old" });
    }
    await commands.get("memory-review").handler("", ctx);
    await guarded();
    hooks.get("agent_settled")();
    await call("memory_update", { id: "x", content: "new" });
    await call("memory_forget", { id: "x" });
    await call("memory_consolidate", {});
    await guarded();
    hooks.get("agent_settled")();
    hooks.get("message_end")({
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "memory_consolidate",
            arguments: {},
          },
        ],
      },
    });
    await guarded();
    hooks.get("agent_settled")();
    failDispatch = true;
    await assert.rejects(
      commands.get("memory-review").handler("", ctx),
      /dispatch failed/,
    );
    await call("memory_update", { id: "x", content: "new" });
  } finally {
    MemoryManager.prototype.isReady = ready;
    MemoryManager.prototype.update = update;
    MemoryManager.prototype.forget = forget;
    MemoryManager.prototype.captureWritePrecondition = capture;
    await rm(cwd, { recursive: true, force: true });
  }
});
