import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import extension from "./index.ts";

test("memory_init preserves malformed lines and memory_repair explicitly removes them", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-init-messaging-"));
  const manager = new MemoryManager(root, { semanticEnabled: false });
  const originalInit = MemoryManager.prototype.init;
  const originalRepair = MemoryManager.prototype.repair;
  const originalIsReady = MemoryManager.prototype.isReady;
  const tools = new Map<string, any>();
  try {
    await mkdir(join(root, ".pi", "memory"), { recursive: true });
    await writeFile(
      join(root, ".pi", "pi-tools.json"),
      JSON.stringify({ version: 1, extensions: { memory: { enabled: true } } }),
    );
    const path = join(root, ".pi", "memory", "knowledge.ndjson");
    const valid = JSON.stringify({
      id: "fixture-id",
      content: "Valid fixture.",
      created: "2025-01-01T00:00:00.000Z",
    });
    const original = `${valid}\nmalformed line\n`;
    await writeFile(path, original);
    // Use the real manager implementation with semantic indexing disabled, so no model is loaded.
    MemoryManager.prototype.init = async function (force, seed) {
      return originalInit.call(manager, force, seed);
    };
    MemoryManager.prototype.repair = async function () {
      return originalRepair.call(manager);
    };
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
    } as any);
    const ctx = { cwd: root, isProjectTrusted: () => true };
    const init = await tools
      .get("memory_init")
      .execute("", {}, undefined, undefined, ctx);
    assert.match(init.content[0].text, /Initialized memory/);
    assert.doesNotMatch(init.content[0].text, /removed|repair/i);
    assert.equal(init.details.recoveredLines, 0);
    assert.equal(await readFile(path, "utf8"), original);
    const repair = await tools
      .get("memory_repair")
      .execute("", {}, undefined, undefined, ctx);
    assert.match(repair.content[0].text, /Removed 1 malformed NDJSON line/);
    assert.equal(await readFile(path, "utf8"), `${valid}\n`);
  } finally {
    MemoryManager.prototype.init = originalInit;
    MemoryManager.prototype.repair = originalRepair;
    MemoryManager.prototype.isReady = originalIsReady;
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
