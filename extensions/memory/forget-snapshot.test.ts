import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryManager, NdjsonMemoryStore } from "./core.ts";

async function fixture(
  run: (cwd: string, store: NdjsonMemoryStore) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "memory-forget-snapshot-"));
  try {
    const store = new NdjsonMemoryStore(cwd, ".pi/memory");
    await store.ensureReady();
    await run(cwd, store);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const path = (cwd: string, category: string) =>
  join(cwd, `.pi/memory/${category}.ndjson`);

test("manager removes only the target, persists bytes and reconciles the index", async () => {
  await fixture(async (cwd) => {
    const manager = new MemoryManager(cwd, { semanticEnabled: false });
    try {
      const target = (
        await manager.remember("knowledge", "removal unique phrase")
      ).memory;
      const survivor = (await manager.remember("knowledge", "survivor phrase"))
        .memory;
      const before = await readFile(path(cwd, "knowledge"), "utf8");
      const expected = (await manager.captureWritePrecondition(target.id))!;
      const snapshot = await manager.captureAddPrecondition();
      assert.equal(
        (await manager.forgetWithSnapshot(target.id, expected, snapshot))?.id,
        target.id,
      );
      assert.equal(
        await readFile(path(cwd, "knowledge"), "utf8"),
        before.replace(expected.rawLine, ""),
      );
      assert.equal(
        (await manager.recall({ query: "removal" })).memories.length,
        0,
      );
      assert.equal(
        (await manager.recall({ query: "survivor" })).memories[0].id,
        survivor.id,
      );
      await assert.rejects(
        manager.forgetWithSnapshot(target.id, expected, snapshot),
        /conflict/,
      );
    } finally {
      await manager.close();
    }
    const reopened = new NdjsonMemoryStore(cwd, ".pi/memory");
    assert.equal((await reopened.list()).length, 1);
  });
});

test("all categories and modes are checked, including source and target edits", async () => {
  for (const category of ["knowledge", "practices", "decisions"] as const) {
    await fixture(async (cwd, store) => {
      const target = (await store.remember("knowledge", "target")).memory;
      await store.remember("practices", "evidence source");
      const expected = (await store.captureWritePrecondition(target.id))!;
      const snapshot = await store.captureAddPrecondition();
      const file = path(cwd, category);
      const contents = await readFile(file, "utf8");
      await writeFile(file, contents + "\n");
      await assert.rejects(
        store.forgetWithSnapshot(target.id, expected, snapshot),
        /conflict/,
      );
      assert.equal(await readFile(file, "utf8"), contents + "\n");
      await writeFile(file, contents);
      const mode = (await stat(file)).mode & 0o777;
      await chmod(file, mode === 0o600 ? 0o640 : 0o600);
      await assert.rejects(
        store.forgetWithSnapshot(target.id, expected, snapshot),
        /conflict/,
      );
      assert.equal(await readFile(file, "utf8"), contents);
    });
  }
});

test("target raw line and identity remain mandatory even with a current snapshot", async () => {
  await fixture(async (cwd, store) => {
    const item = (await store.remember("knowledge", "target")).memory;
    const expected = (await store.captureWritePrecondition(item.id))!;
    const file = path(cwd, "knowledge");
    const changed = ` ${await readFile(file, "utf8")}`;
    await writeFile(file, changed);
    const snapshot = await store.captureAddPrecondition();
    await assert.rejects(
      store.forgetWithSnapshot(item.id, expected, snapshot),
      /conflict/,
    );
    await assert.rejects(
      store.forgetWithSnapshot("missing", expected, snapshot),
      /conflict/,
    );
    await assert.rejects(
      store.forgetWithSnapshot(item.id, expected, {} as never),
      /conflict/,
    );
    await assert.rejects(
      store.forgetWithSnapshot(item.id, undefined as never, snapshot),
      /conflict/,
    );
    assert.equal(await readFile(file, "utf8"), changed);
    assert.equal(await store.forget("missing"), null);
  });
});

test("competing writers and external changes during replacement cannot be overwritten", async () => {
  await fixture(async (cwd, store) => {
    const item = (await store.remember("knowledge", "target")).memory;
    const expected = (await store.captureWritePrecondition(item.id))!;
    const snapshot = await store.captureAddPrecondition();
    const other = new NdjsonMemoryStore(cwd, ".pi/memory");
    const results = await Promise.allSettled([
      store.forgetWithSnapshot(item.id, expected, snapshot),
      other.remember("decisions", "competing", snapshot),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
  });
  await fixture(async (cwd, store) => {
    const item = (await store.remember("knowledge", "target")).memory;
    const expected = (await store.captureWritePrecondition(item.id))!;
    const snapshot = await store.captureAddPrecondition();
    const other = path(cwd, "decisions");
    const racing = new NdjsonMemoryStore(cwd, ".pi/memory", async () =>
      writeFile(other, "manual\n"),
    );
    await assert.rejects(
      racing.forgetWithSnapshot(item.id, expected, snapshot),
      /conflict/,
    );
    assert.equal(await readFile(other, "utf8"), "manual\n");
    assert.equal(
      await readFile(path(cwd, "knowledge"), "utf8"),
      expected.rawLine,
    );
  });
});

test("malformed data blocks removal without repair or byte changes", async () => {
  await fixture(async (cwd, store) => {
    const item = (await store.remember("knowledge", "target")).memory;
    const expected = (await store.captureWritePrecondition(item.id))!;
    const snapshot = await store.captureAddPrecondition();
    const file = path(cwd, "decisions");
    await writeFile(file, "malformed\n");
    await assert.rejects(
      store.forgetWithSnapshot(item.id, expected, snapshot),
      /malformed/,
    );
    assert.equal(await readFile(file, "utf8"), "malformed\n");
    assert.equal(
      await readFile(path(cwd, "knowledge"), "utf8"),
      expected.rawLine,
    );
  });
});
