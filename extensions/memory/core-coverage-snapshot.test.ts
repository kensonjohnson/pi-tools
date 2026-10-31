import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryManager, NdjsonMemoryStore } from "./core.ts";
import type { CoverageSnapshotAuthority } from "./coverage-ledger.ts";

async function fixture(
  run: (cwd: string, store: NdjsonMemoryStore) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "memory-coverage-"));
  try {
    const store = new NdjsonMemoryStore(cwd, ".pi/memory");
    await store.ensureReady();
    await run(cwd, store);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("manager authority serializes cooperating writers and refreshes external changes and modes", async () => {
  await fixture(async (cwd, store) => {
    const authority: CoverageSnapshotAuthority = new MemoryManager(cwd, {
      semanticEnabled: false,
    });
    const entered = deferred();
    const release = deferred();
    const path = join(cwd, ".pi/memory/decisions.ndjson");
    const external = `${JSON.stringify({ id: "external", content: "human", created: "today" })}\n`;
    let writerDone = false;
    const holding = authority.withSnapshot(async (read) => {
      const first = await read();
      assert.equal(first.snapshots.decisions.contents, "");
      entered.resolve();
      await release.promise;
      await writeFile(path, external);
      await chmod(path, 0o600);
      const second = await read();
      assert.equal(second.snapshots.decisions.contents, external);
      assert.equal(second.snapshots.decisions.mode, 0o600);
      assert.equal(writerDone, false);
    });
    await entered.promise;
    const writer = store.remember("knowledge", "cooperating").then(() => {
      writerDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(writerDone, false);
    release.resolve();
    await holding;
    await writer;
    assert.equal(await readFile(path, "utf8"), external);
    assert.equal((await store.list("knowledge")).length, 1);
  });
});

test("read-only coverage authority holds the canonical lock without initializing or recovering memory", async () => {
  await fixture(async (cwd, store) => {
    const manager = new MemoryManager(cwd, { semanticEnabled: false });
    const before = await manager.captureReadOnlyPrecondition();
    const entered = deferred(),
      release = deferred();
    let writerDone = false;
    const holding = manager.withReadOnlySnapshot(async (read) => {
      assert.deepEqual(await read(), before);
      entered.resolve();
      await release.promise;
      assert.deepEqual(await read(), before);
      assert.equal(writerDone, false);
    });
    await entered.promise;
    const writer = store.remember("knowledge", "cooperating").then(() => {
      writerDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(writerDone, false);
    release.resolve();
    await holding;
    await writer;
    assert.equal(writerDone, true);
    await manager.close();
  });
});

test("failure, cancellation and expired readers release the lock without editing memories", async () => {
  await fixture(async (cwd, store) => {
    let expired!: () => Promise<unknown>;
    await assert.rejects(
      store.withSnapshot(async (read) => {
        expired = read;
        await read();
        throw new Error("callback failed");
      }),
      /callback failed/,
    );
    await assert.rejects(expired(), /callback has ended/);
    const controller = new AbortController();
    await assert.rejects(
      store.withSnapshot(async (read) => {
        controller.abort();
        await read();
      }, controller.signal),
      { name: "AbortError" },
    );
    for (const category of ["knowledge", "practices", "decisions"]) {
      assert.equal(
        await readFile(join(cwd, `.pi/memory/${category}.ndjson`), "utf8"),
        "",
      );
    }
    await store.remember("knowledge", "lock released");
  });
});

test("cancellation while waiting for the canonical lock does not run the callback", async () => {
  await fixture(async (cwd, store) => {
    const entered = deferred();
    const release = deferred();
    const holding = store.withSnapshot(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    let called = false;
    const waiting = new NdjsonMemoryStore(cwd, ".pi/memory").withSnapshot(
      async () => {
        called = true;
      },
      controller.signal,
    );
    controller.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    assert.equal(called, false);
    release.resolve();
    await holding;
  });
});

test("snapshot rejects malformed and duplicate records without repairing them", async () => {
  await fixture(async (cwd, store) => {
    const one = join(cwd, ".pi/memory/knowledge.ndjson");
    const two = join(cwd, ".pi/memory/practices.ndjson");
    await writeFile(one, "bad\n");
    await assert.rejects(
      store.withSnapshot((read) => read()),
      /malformed/,
    );
    assert.equal(await readFile(one, "utf8"), "bad\n");
    const line = `${JSON.stringify({ id: "same", content: "value", created: "today" })}\n`;
    await writeFile(one, line);
    await writeFile(two, line);
    await assert.rejects(
      store.withSnapshot((read) => read()),
      /duplicate id/,
    );
    assert.equal(await readFile(one, "utf8"), line);
    assert.equal(await readFile(two, "utf8"), line);
  });
});
