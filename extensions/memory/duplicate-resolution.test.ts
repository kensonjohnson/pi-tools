import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NdjsonMemoryStore } from "./core.ts";

async function fixture(
  run: (dir: string, store: NdjsonMemoryStore) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "memory-duplicates-"));
  try {
    const store = new NdjsonMemoryStore(dir, "memory");
    await store.ensureReady();
    await run(dir, store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const first = '{"id":"same","content":"first","created":"t"}\n';
const second =
  '  { "extra": {"id":"same"}, "id" : "same", "content":"second", "created":"u", "updated":"v" }\r\n';
const third = '{"id":"same","content":"third","created":"w"}';
async function seed(dir: string) {
  await writeFile(join(dir, "memory/knowledge.ndjson"), first + second);
  await writeFile(join(dir, "memory/practices.ndjson"), third);
}
test("resolves later IDs while preserving all other bytes", async () =>
  fixture(async (dir, store) => {
    await seed(dir);
    await assert.rejects(store.captureAddPrecondition(), /duplicate id/);
    const { changes } = await store.resolveDuplicateIds();
    assert.equal(changes.length, 2);
    assert.notEqual(changes[0].newId, changes[1].newId);
    assert.equal(
      await readFile(join(dir, "memory/knowledge.ndjson"), "utf8"),
      first + second.replace('"id" : "same"', `"id" : "${changes[0].newId}"`),
    );
    assert.equal(
      await readFile(join(dir, "memory/practices.ndjson"), "utf8"),
      third.replace('"id":"same"', `"id":"${changes[1].newId}"`),
    );
    await store.captureAddPrecondition();
    assert.deepEqual(await store.resolveDuplicateIds(), {
      transactionId: null,
      changes: [],
    });
    assert.equal((await store.listDuplicateIdResolutions()).length, 1);
  }));
test("interrupted multi-file transaction recovers without changing chosen IDs", async () =>
  fixture(async (dir) => {
    await seed(dir);
    let interrupted = false;
    const store = new NdjsonMemoryStore(
      dir,
      "memory",
      undefined,
      async (phase) => {
        if (phase === "destination" && !interrupted) {
          interrupted = true;
          throw new Error("crash");
        }
      },
    );
    await assert.rejects(store.resolveDuplicateIds(), /crash/);
    const firstAfter = await readFile(
      join(dir, "memory/knowledge.ndjson"),
      "utf8",
    );
    const recovered = new NdjsonMemoryStore(dir, "memory");
    await recovered.captureAddPrecondition();
    assert.equal(
      await readFile(join(dir, "memory/knowledge.ndjson"), "utf8"),
      firstAfter,
    );
    assert.equal(
      new Set((await recovered.list()).map((item) => item.id)).size,
      3,
    );
    const receipts = await recovered.listDuplicateIdResolutions();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].changes.length, 2);
  }));
test("interrupted transaction refuses external edits", async () =>
  fixture(async (dir) => {
    await seed(dir);
    const store = new NdjsonMemoryStore(
      dir,
      "memory",
      undefined,
      async (phase) => {
        if (phase === "journal") throw new Error("crash");
      },
    );
    await assert.rejects(store.resolveDuplicateIds(), /crash/);
    const file = join(dir, "memory/decisions.ndjson");
    await writeFile(file, "human edit\n");
    await assert.rejects(
      new NdjsonMemoryStore(dir, "memory").resolveDuplicateIds(),
      /files changed/,
    );
    assert.equal(await readFile(file, "utf8"), "human edit\n");
  }));
test("rejects ambiguous id fields and malformed lines without changes", async () =>
  fixture(async (dir, store) => {
    const file = join(dir, "memory/knowledge.ndjson");
    const input =
      first + '{"id":"x","id":"same","content":"x","created":"t"}\n';
    await writeFile(file, input);
    await assert.rejects(
      store.resolveDuplicateIds(),
      /id changed|ambiguous id/,
    );
    assert.equal(await readFile(file, "utf8"), input);
    await writeFile(file, first + "bad\n");
    await assert.rejects(store.resolveDuplicateIds(), /malformed line/);
  }));
