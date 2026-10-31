import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "./index.ts";

test("review status and cancellation do not create a legacy scheduler or dispatch a model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-status-"));
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const notices: string[] = [];
  let calls = 0;
  const ctx: any = {
    cwd,
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
    isProjectTrusted: () => true,
    modelRegistry: {
      find() {
        calls++;
      },
    },
  };
  try {
    extension({
      events: {
        on() {
          return () => {};
        },
        emit() {},
      },
      on() {},
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: any) {
        commands.set(name, command);
      },
    } as any);
    for (const action of ["status", "cancel", "resume"]) {
      await commands.get("memory-review").handler(action, ctx);
      const result = await tools
        .get("memory_review")
        .execute("", { action }, undefined, undefined, ctx);
      assert.match(result.content[0].text, /foreground|background/);
    }
    assert.equal(notices.length, 3);
    assert.equal(calls, 0);
    await assert.rejects(access(join(cwd, ".pi")), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
