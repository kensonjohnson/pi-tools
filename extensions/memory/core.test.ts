import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryManager, NdjsonMemoryStore } from "./core.ts";

async function withStore(
  run: (store: NdjsonMemoryStore, cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-memory-"));
  try {
    const store = new NdjsonMemoryStore(cwd, ".pi/memory");
    await store.ensureReady();
    await run(store, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("repair retains valid NDJSON records and removes malformed lines", async () => {
  await withStore(async (store, cwd) => {
    const valid = {
      content: "Valid memory survives repair.",
      id: "019f733a-329c-72d9-9c86-770704954eaa",
      created: "2026-07-18T03:17:01.724Z",
    };
    const file = join(cwd, ".pi/memory/decisions.ndjson");
    await writeFile(
      file,
      `${JSON.stringify(valid)}\n0-1052691be3c2","created":"2026-07-19T18:12:24.611Z"}\nnot JSON\n`,
      "utf8",
    );

    const recovery = await store.repair();

    assert.deepEqual(recovery.removedLines, {
      knowledge: 0,
      practices: 0,
      decisions: 2,
    });
    assert.equal(recovery.totalRemovedLines, 2);
    assert.deepEqual(await store.list("decisions"), [
      { ...valid, category: "decisions", updated: undefined },
    ]);

    const repaired = await readFile(file, "utf8");
    assert.equal(repaired, `${JSON.stringify(valid)}\n`);
  });
});

test("manager repair reports malformed lines removed during initialization", async () => {
  await withStore(async (store, cwd) => {
    const file = join(cwd, ".pi/memory/practices.ndjson");
    await writeFile(
      file,
      `${JSON.stringify({
        content: "A valid practice.",
        id: "019f733a-329c-72d9-9c86-770704954eaa",
        created: "2026-07-18T03:17:01.724Z",
      })}\ntruncated tail`,
      "utf8",
    );

    const manager = new MemoryManager(cwd, { semanticEnabled: false });
    try {
      const recovery = await manager.repair();
      assert.equal(recovery.totalRemovedLines, 1);
      assert.equal(recovery.removedLines.practices, 1);
      assert.equal((await store.list("practices")).length, 1);
    } finally {
      await manager.close();
    }
  });
});

test("memory_init repairs corruption added after manager initialization", async () => {
  await withStore(async (store, cwd) => {
    const manager = new MemoryManager(cwd, { semanticEnabled: false });
    try {
      await manager.init();
      const file = join(cwd, ".pi/memory/knowledge.ndjson");
      await writeFile(file, "malformed tail\n", "utf8");

      const result = await manager.init();

      assert.equal(result.recoveredLines, 1);
      assert.equal(await readFile(file, "utf8"), "");
    } finally {
      await manager.close();
    }
  });
});

test("concurrent remembers append complete, independent NDJSON lines", async () => {
  await withStore(async (store, cwd) => {
    const count = 50;
    const results = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        store.remember("knowledge", `Concurrent memory ${index}.`),
      ),
    );

    assert.equal(results.filter((result) => result.created).length, count);
    assert.equal((await store.list("knowledge")).length, count);

    const file = join(cwd, ".pi/memory/knowledge.ndjson");
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    assert.equal(lines.length, count);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });
});
