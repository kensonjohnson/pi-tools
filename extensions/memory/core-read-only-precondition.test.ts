import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryManager, NdjsonMemoryStore } from "./core.ts";

async function fixture(
  run: (cwd: string, store: NdjsonMemoryStore) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "memory-read-only-"));
  try {
    const store = new NdjsonMemoryStore(cwd, ".pi/memory");
    await store.ensureReady();
    await run(cwd, store);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function canonical(cwd: string) {
  return Promise.all(
    ["knowledge", "practices", "decisions"].map((category) =>
      readFile(join(cwd, `.pi/memory/${category}.ndjson`), "utf8"),
    ),
  );
}

for (const [kind, checkpoint] of [
  ["duplicate", "journal"],
  ["duplicate", "destination"],
  ["move", "journal"],
  ["move", "destination"],
] as const) {
  test(`read-only capture refuses ${kind} interrupted at ${checkpoint} without changing files`, async () => {
    await fixture(async (cwd, store) => {
      let moveId = "";
      if (kind === "duplicate") {
        await writeFile(
          join(cwd, ".pi/memory/knowledge.ndjson"),
          '{"id":"same","content":"one","created":"t"}\n{"id":"same","content":"two","created":"t"}\n',
        );
      } else {
        moveId = (await store.remember("knowledge", "move me")).memory.id;
      }
      const interrupted = new NdjsonMemoryStore(
        cwd,
        ".pi/memory",
        undefined,
        async (phase) => {
          if (phase === checkpoint) throw new Error("interrupted");
        },
      );
      if (kind === "duplicate") {
        await assert.rejects(interrupted.resolveDuplicateIds(), /interrupted/);
      } else {
        const expected = (await interrupted.captureMovePrecondition(moveId))!;
        await assert.rejects(
          interrupted.move(expected, "practices"),
          /interrupted/,
        );
      }
      const before = await canonical(cwd);
      const runtime = join(cwd, ".pi/memory/.runtime");
      const entries = (await readdir(runtime)).sort();
      const journal = join(
        runtime,
        `${kind === "duplicate" ? "duplicate" : "move"}-transaction.json`,
      );
      const journalBytes = await readFile(journal);
      const manager = new MemoryManager(cwd, { semanticEnabled: false });
      await assert.rejects(
        manager.captureReadOnlyPrecondition(),
        /read-only conflict: recovery pending/,
      );
      await assert.rejects(
        manager.withReadOnlySnapshot((read) => read()),
        /read-only conflict: recovery pending/,
      );
      assert.deepEqual(await canonical(cwd), before);
      assert.deepEqual((await readdir(runtime)).sort(), entries);
      assert.deepEqual(await readFile(journal), journalBytes);
      await manager.close();
    });
  });
}

test("read-only capture preserves modes and rejects malformed and duplicate data", async () => {
  await fixture(async (cwd, store) => {
    const knowledge = join(cwd, ".pi/memory/knowledge.ndjson");
    const practices = join(cwd, ".pi/memory/practices.ndjson");
    await chmod(knowledge, 0o640);
    const snapshot = await store.captureReadOnlyPrecondition();
    assert.equal(snapshot.snapshots.knowledge.mode, 0o640);
    await writeFile(knowledge, "bad\n");
    await assert.rejects(store.captureReadOnlyPrecondition(), /malformed/);
    assert.equal(await readFile(knowledge, "utf8"), "bad\n");
    const line = '{"id":"same","content":"one","created":"t"}\n';
    await writeFile(knowledge, line);
    await writeFile(practices, line);
    await assert.rejects(store.captureReadOnlyPrecondition(), /duplicate id/);
    assert.deepEqual(await canonical(cwd), [line, line, ""]);
  });
});

test("read-only capture waits for cooperating writer and can be cancelled while waiting", async () => {
  await fixture(async (cwd, store) => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const writer = new NdjsonMemoryStore(cwd, ".pi/memory", async () => {
      enter();
      await gate;
    });
    const writing = writer.remember("knowledge", "serialized");
    await entered;
    const controller = new AbortController();
    const cancelled = store.captureReadOnlyPrecondition(controller.signal);
    const waiting = store.captureReadOnlyPrecondition();
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(settled, false);
    controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    release();
    await writing;
    const captured = await waiting;
    assert.match(captured.snapshots.knowledge.contents, /serialized/);
  });
});

test("read-only capture does not create missing canonical category files", async () => {
  await fixture(async (cwd, store) => {
    const path = join(cwd, ".pi/memory/decisions.ndjson");
    await rm(path);
    await assert.rejects(store.captureReadOnlyPrecondition(), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(path), { code: "ENOENT" });
  });
});
