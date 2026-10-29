import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryManager, NdjsonMemoryStore } from "./core.ts";

async function fixture(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "memory-provider-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const timeout = () =>
  new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error("writer blocked by provider")),
      2000,
    );
    timer.unref();
  });

test("changing vector dimensions falls back without deleting the live database", async () => {
  await fixture(async (cwd) => {
    const provider2 = {
      name: () => "test",
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    };
    const provider3 = {
      name: () => "test",
      embed: async () => [1, 0, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    };
    const a = new MemoryManager(cwd, {
      semanticEnabled: true,
      embeddingDimensions: 2,
      embeddingProvider: provider2,
    });
    const b = new MemoryManager(cwd, {
      semanticEnabled: true,
      embeddingDimensions: 3,
      embeddingProvider: provider3,
    });
    try {
      await a.remember("knowledge", "unique dimension token");
      assert.equal(
        (await a.recall({ query: "unique" })).searchMode,
        "semantic",
      );
      const result = await b.recall({ query: "unique" });
      assert.equal(result.memories.length, 1);
      assert.notEqual(result.searchMode, "semantic");
      assert.equal((await a.recall({ query: "unique" })).memories.length, 1);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

test("slow batch and query embeddings do not hold write lock and stale snapshots retry", async () => {
  for (const phase of ["batch", "query"])
    await fixture(async (cwd) => {
      const store = new NdjsonMemoryStore(cwd, ".pi/memory");
      await store.ensureReady();
      const original = (await store.remember("knowledge", "initial token"))
        .memory;
      const entered = deferred();
      const release = deferred();
      let pause = true;
      const provider = {
        name: () => "slow-offline",
        embed: async () => {
          if (phase === "query" && pause) {
            pause = false;
            entered.resolve();
            await release.promise;
          }
          return [1, 0];
        },
        embedBatch: async (texts: string[]) => {
          if (phase === "batch" && pause) {
            pause = false;
            entered.resolve();
            await release.promise;
          }
          return texts.map(() => [1, 0]);
        },
      };
      const manager = new MemoryManager(cwd, {
        semanticEnabled: true,
        embeddingDimensions: 2,
        embeddingProvider: provider,
      });
      try {
        await manager.initialize();
        const pending = manager.recall({ query: "token" });
        await entered.promise;
        try {
          await Promise.race([
            manager.update(original.id, "updated token"),
            timeout(),
          ]);
        } finally {
          release.resolve();
        }
        const result = await pending;
        assert.equal(result.memories.length, 1);
        assert.equal(result.memories[0].content, "updated token");
      } finally {
        release.resolve();
        await manager.close();
      }
    });
});
