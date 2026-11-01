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
  const cwd = await mkdtemp(join(tmpdir(), "memory-add-"));
  try {
    const store = new NdjsonMemoryStore(cwd, ".pi/memory");
    await store.ensureReady();
    await run(cwd, store);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("conditional add indexes successfully and retains unconditional and duplicate behavior", async () => {
  await fixture(async (cwd) => {
    const manager = new MemoryManager(cwd, { semanticEnabled: false });
    try {
      const expected = await manager.captureAddPrecondition();
      const added = await manager.remember(
        "knowledge",
        "fresh add term",
        expected,
      );
      assert.equal(added.created, true);
      assert.equal(
        (await manager.recall({ query: "fresh" })).memories[0].id,
        added.memory.id,
      );
      const current = await manager.captureAddPrecondition();
      const duplicate = await manager.remember(
        "knowledge",
        "  fresh   add term ",
        current,
      );
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.memory.id, added.memory.id);
      assert.equal(
        (await manager.remember("knowledge", "fresh add term")).created,
        false,
      );
      assert.equal(
        (await manager.remember("decisions", "unconditional")).created,
        true,
      );
    } finally {
      await manager.close();
    }
  });
});

test("stale proposal conflicts before duplicate check for edits in any category or mode", async () => {
  for (const category of ["knowledge", "practices", "decisions"] as const)
    await fixture(async (cwd, store) => {
      const expected = await store.captureAddPrecondition();
      const changed = await store.remember(category, "proposed text");
      const path = join(cwd, `.pi/memory/${category}.ndjson`);
      const before = await readFile(path, "utf8");
      await assert.rejects(
        store.remember(category, "proposed text", expected),
        /add conflict/,
      );
      assert.equal(await readFile(path, "utf8"), before);
      assert.equal((await store.list(category))[0].id, changed.memory.id);
      const modeExpected = await store.captureAddPrecondition();
      const mode = (await stat(path)).mode & 0o777;
      await chmod(path, mode === 0o600 ? 0o640 : 0o600);
      await assert.rejects(
        store.remember("knowledge", "new entry", modeExpected),
        /add conflict/,
      );
      assert.equal(await readFile(path, "utf8"), before);
    });
});

test("competing adds from one snapshot serialize and only one succeeds", async () => {
  await fixture(async (cwd, store) => {
    const expected = await store.captureAddPrecondition();
    const other = new NdjsonMemoryStore(cwd, ".pi/memory");
    const outcomes = await Promise.allSettled([
      store.remember("knowledge", "first", expected),
      other.remember("decisions", "second", expected),
    ]);
    assert.equal(
      outcomes.filter((entry) => entry.status === "fulfilled").length,
      1,
    );
    assert.equal(
      outcomes.filter((entry) => entry.status === "rejected").length,
      1,
    );
    assert.equal((await store.list()).length, 1);
  });
});

test("external edits immediately before replacement remain intact", async () => {
  await fixture(async (cwd, store) => {
    const expected = await store.captureAddPrecondition();
    const file = join(cwd, ".pi/memory/decisions.ndjson");
    const human = `${JSON.stringify({ id: "manual", content: "human edit", created: "today" })}\n`;
    const racing = new NdjsonMemoryStore(cwd, ".pi/memory", async () =>
      writeFile(file, human),
    );
    await assert.rejects(
      racing.remember("knowledge", "proposal", expected),
      /conflict/,
    );
    assert.equal(await readFile(file, "utf8"), human);
    assert.equal(
      await readFile(join(cwd, ".pi/memory/knowledge.ndjson"), "utf8"),
      "",
    );
  });
});

test("malformed records and duplicate IDs block capture and add without changing bytes", async () => {
  await fixture(async (cwd, store) => {
    const file = join(cwd, ".pi/memory/knowledge.ndjson");
    const expected = await store.captureAddPrecondition();
    await writeFile(file, "broken\n");
    await assert.rejects(store.captureAddPrecondition(), /malformed/);
    await assert.rejects(
      store.remember("decisions", "new", expected),
      /malformed/,
    );
    assert.equal(await readFile(file, "utf8"), "broken\n");
    const record = `${JSON.stringify({ id: "duplicate", content: "existing", created: "today" })}\n`;
    await writeFile(file, record + record);
    await assert.rejects(store.captureAddPrecondition(), /duplicate/);
    await assert.rejects(
      store.remember("decisions", "new", expected),
      /duplicate/,
    );
    assert.equal(await readFile(file, "utf8"), record + record);
  });
});
