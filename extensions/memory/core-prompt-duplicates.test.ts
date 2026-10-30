import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryManager } from "./core.ts";

test("prompt refreshes duplicate warnings as external edits introduce, resolve and reintroduce IDs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "memory-prompt-duplicates-"));
  const manager = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    await manager.remember("knowledge", "original text");
    const file = join(cwd, ".pi/memory/knowledge.ndjson");
    const original = await readFile(file, "utf8");
    const record = JSON.parse(original);
    const duplicate = (content: string) =>
      `${original}${JSON.stringify({ ...record, content })}\n`;

    await writeFile(file, duplicate("first duplicate needle"));
    assert.match(await manager.buildPromptContext(), /first duplicate needle/);
    assert.equal(manager.getWarnings()[0].id, record.id);
    let result = await manager.recall({ query: "duplicate needle" });
    assert.equal(result.searchMode, "grep");
    assert.deepEqual(
      result.memories.map((memory) => memory.content),
      ["first duplicate needle"],
    );
    assert.equal(result.warnings?.[0].id, record.id);

    await writeFile(file, original);
    await manager.buildPromptContext();
    assert.deepEqual(manager.getWarnings(), []);

    await writeFile(file, duplicate("second duplicate needle"));
    assert.match(await manager.buildPromptContext(), /second duplicate needle/);
    assert.equal(manager.getWarnings()[0].id, record.id);
    result = await manager.recall({ query: "duplicate needle" });
    assert.equal(result.searchMode, "grep");
    assert.deepEqual(
      result.memories.map((memory) => memory.content),
      ["second duplicate needle"],
    );
    assert.equal(result.warnings?.[0].id, record.id);
    assert.equal(
      await readFile(file, "utf8"),
      duplicate("second duplicate needle"),
    );
  } finally {
    await manager.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
