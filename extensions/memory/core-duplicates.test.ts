import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryManager, NdjsonMemoryStore } from "./core.ts";

test("duplicate IDs degrade reads without changing records or permitting ambiguous writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-duplicates-"));
  const store = new NdjsonMemoryStore(cwd, ".pi/memory");
  const manager = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await store.ensureReady();
    const line = (id: string, content: string) =>
      JSON.stringify({ id, content, created: "2026-01-01T00:00:00Z" });
    const knowledge = `${line("same", "needle first")}\n${line("same", "needle second")}\n`;
    const practices = `${line("same", "needle third")}\n${line("other", "needle fourth")}\n`;
    const knowledgePath = join(store.memoryDir, "knowledge.ndjson");
    const practicesPath = join(store.memoryDir, "practices.ndjson");
    await writeFile(knowledgePath, knowledge);
    await writeFile(practicesPath, practices);
    const init = await manager.init();
    assert.equal(init.semanticEnabled, false);
    assert.deepEqual(init.warnings?.[0].locations, [
      { category: "knowledge", line: 1 },
      { category: "knowledge", line: 2 },
      { category: "practices", line: 1 },
    ]);
    assert.match(await manager.buildPromptContext(), /needle first/);
    assert.match(await manager.buildPromptContext(), /needle second/);
    const result = await manager.recall({ query: "needle" });
    assert.equal(result.searchMode, "grep");
    assert.equal(result.memories.length, 4);
    assert.equal(result.warnings?.[0].id, "same");
    assert.equal(
      (
        await manager.recall({
          query: "needle",
          category: "practices",
          limit: 1,
        })
      ).memories.length,
      1,
    );
    await assert.rejects(manager.update("same", "changed"), /duplicate id/);
    await assert.rejects(manager.forget("same"), /duplicate id/);
    await assert.rejects(
      manager.captureMovePrecondition("same"),
      /duplicate id/,
    );
    await assert.rejects(manager.remember("decisions", "new"), /duplicate id/);
    assert.equal(await readFile(knowledgePath, "utf8"), knowledge);
    assert.equal(await readFile(practicesPath, "utf8"), practices);
    await writeFile(
      practicesPath,
      `${line("third", "needle third")}\n${line("other", "needle fourth")}\n`,
    );
    await writeFile(
      knowledgePath,
      `${line("same", "needle first")}\n${line("second", "needle second")}\n`,
    );
    const recovered = await manager.recall({ query: "needle" });
    assert.notEqual(recovered.searchMode, "grep");
    assert.deepEqual(manager.getWarnings(), []);
  } finally {
    await manager.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("duplicates introduced after initialization bypass the existing index", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-duplicates-"));
  const manager = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await manager.remember("knowledge", "original needle");
    const file = join(cwd, ".pi/memory/knowledge.ndjson");
    const original = await readFile(file, "utf8");
    const record = JSON.parse(original);
    await writeFile(
      file,
      original + JSON.stringify({ ...record, content: "new needle" }) + "\n",
    );
    const result = await manager.recall({ query: "needle" });
    assert.equal(result.searchMode, "grep");
    assert.deepEqual(
      result.memories.map((m) => m.content),
      ["original needle", "new needle"],
    );
    assert.equal(manager.getWarnings().length, 1);
  } finally {
    await manager.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
