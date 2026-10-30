import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, NdjsonMemoryStore } from "./core.ts";

const records =
  '{"id":"x","content":"one","created":"t"}\n{"id":"x","content":"two","created":"t"}\n';
async function fixture(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "memory-cancel-"));
  try {
    const store = new NdjsonMemoryStore(dir, "memory");
    await store.ensureReady();
    await writeFile(join(dir, "memory/knowledge.ndjson"), records);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
for (const useManager of [false, true])
  test(`abort while waiting for canonical lock (${useManager ? "manager" : "store"})`, async () =>
    fixture(async (dir) => {
      const lock = new Database(join(dir, "memory/write-lock.db"));
      lock.exec("BEGIN IMMEDIATE");
      const controller = new AbortController();
      const store = useManager
        ? new MemoryManager(dir, {
            memoryDirName: "memory",
            semanticEnabled: false,
          })
        : new NdjsonMemoryStore(dir, "memory");
      try {
        const pending = store.resolveDuplicateIds(controller.signal);
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.abort();
        await assert.rejects(pending, { name: "AbortError" });
      } finally {
        lock.exec("ROLLBACK");
        lock.close();
        if (store instanceof MemoryManager) await store.close();
      }
      assert.equal(
        await readFile(join(dir, "memory/knowledge.ndjson"), "utf8"),
        records,
      );
      const runtime = await readdir(join(dir, "memory/.runtime")).catch(
        () => [],
      );
      assert.equal(
        runtime.some((name) => name.startsWith("duplicate-")),
        false,
      );
    }));
test("abort under lock before publication leaves canonical records untouched", async () =>
  fixture(async (dir) => {
    const controller = new AbortController();
    const store = new NdjsonMemoryStore(
      dir,
      "memory",
      undefined,
      async (phase) => {
        if (phase === "duplicate-prepublish") controller.abort();
      },
    );
    await assert.rejects(store.resolveDuplicateIds(controller.signal), {
      name: "AbortError",
    });
    assert.equal(
      await readFile(join(dir, "memory/knowledge.ndjson"), "utf8"),
      records,
    );
    assert.equal((await store.listDuplicateIdResolutions()).length, 0);
  }));
test("abort after publication starts does not interrupt durable repair", async () =>
  fixture(async (dir) => {
    const controller = new AbortController();
    const store = new NdjsonMemoryStore(
      dir,
      "memory",
      undefined,
      async (phase) => {
        if (phase === "duplicate-written") controller.abort();
      },
    );
    const result = await store.resolveDuplicateIds(controller.signal);
    assert.equal(result.changes.length, 1);
    assert.equal((await store.listDuplicateIdResolutions()).length, 1);
  }));
