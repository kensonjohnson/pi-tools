import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";
import { MemoryManager } from "./core.ts";

test("conditional update and forget reject stale content and changes after capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-foreground-condition-"));
  const manager = new MemoryManager(root, { semanticEnabled: false });
  const original = {
    isReady: MemoryManager.prototype.isReady,
    capture: MemoryManager.prototype.captureWritePrecondition,
    update: MemoryManager.prototype.update,
    forget: MemoryManager.prototype.forget,
  };
  const tools = new Map<string, any>();
  let race = false;
  const file = join(root, ".pi/memory/knowledge.ndjson");
  try {
    await manager.init(false, false);
    const item = (await manager.remember("knowledge", "original")).memory;
    MemoryManager.prototype.isReady = async () => true;
    MemoryManager.prototype.captureWritePrecondition = (id) =>
      original.capture.call(manager, id);
    const changeRawLine = async () => {
      const line = JSON.parse(await readFile(file, "utf8"));
      await writeFile(
        file,
        `${JSON.stringify({ ...line, extra: "concurrent" })}\n`,
      );
    };
    MemoryManager.prototype.update = async (id, content, expected) => {
      if (race) await changeRawLine();
      return original.update.call(manager, id, content, expected);
    };
    MemoryManager.prototype.forget = async (id, expected) => {
      if (race) await changeRawLine();
      return original.forget.call(manager, id, expected);
    };
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
    } as any);
    const ctx = { cwd: root, isProjectTrusted: () => true };
    const call = (name: string, params: object) =>
      tools.get(name).execute("", params, undefined, undefined, ctx);
    for (const name of ["memory_update", "memory_forget"]) {
      const params = { id: item.id, content: "new", expectedContent: "stale" };
      await assert.rejects(call(name, params), /conflict.*content changed/i);
      race = true;
      await assert.rejects(
        call(name, { ...params, expectedContent: "original" }),
        /conflict/i,
      );
      race = false;
      assert.equal(
        JSON.parse(await readFile(file, "utf8")).content,
        "original",
      );
      // Restore distinct bytes so each mutation attempt encounters a new change.
      const line = JSON.parse(await readFile(file, "utf8"));
      delete line.extra;
      await writeFile(file, `${JSON.stringify(line)}\n`);
    }
    await call("memory_update", { id: item.id, content: "legacy" });
    assert.equal(JSON.parse(await readFile(file, "utf8")).content, "legacy");
    await call("memory_forget", { id: item.id, expectedContent: "legacy" });
    assert.equal(await readFile(file, "utf8"), "");
  } finally {
    MemoryManager.prototype.isReady = original.isReady;
    MemoryManager.prototype.captureWritePrecondition = original.capture;
    MemoryManager.prototype.update = original.update;
    MemoryManager.prototype.forget = original.forget;
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
