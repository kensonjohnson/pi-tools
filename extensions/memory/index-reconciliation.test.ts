import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryManager, NdjsonMemoryStore } from "./core.ts";

async function fixture(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "memory-index-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
const moduleUrl = new URL("./core.ts", import.meta.url).href;
const fake = {
  name: () => "offline-test",
  embed: async (_text: string) => [1, 0],
  embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
};

test("recall reconciles edits, removal, moves, and force rebuild without replacing live database", async () => {
  await fixture(async (cwd) => {
    const a = new MemoryManager(cwd, { semanticEnabled: false });
    const b = new MemoryManager(cwd, { semanticEnabled: false });
    try {
      const item = (await a.remember("knowledge", "planet original")).memory;
      await b.initialize();
      const file = join(cwd, ".pi/memory/knowledge.ndjson");
      await writeFile(
        file,
        `${JSON.stringify({ ...item, content: "galaxy manual" })}\n`,
      );
      assert.equal((await b.recall({ query: "planet" })).memories.length, 0);
      assert.equal(
        (await b.recall({ query: "galaxy" })).memories[0].id,
        item.id,
      );
      const precondition = (await a.captureMovePrecondition(item.id))!;
      await a.move(precondition, "decisions");
      assert.equal(
        (await b.recall({ query: "galaxy", category: "knowledge" })).memories
          .length,
        0,
      );
      assert.equal(
        (await b.recall({ query: "galaxy", category: "decisions" })).memories[0]
          .id,
        item.id,
      );
      const db = join(cwd, ".pi/memory/vector.db");
      const before = await stat(db);
      await a.init(true);
      const after = await stat(db);
      assert.equal(before.ino, after.ino);
      await a.forget(item.id);
      assert.equal((await b.recall({ query: "galaxy" })).memories.length, 0);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

test("semantic category filtering occurs before limiting and embedding failures fall back", async () => {
  await fixture(async (cwd) => {
    const store = new NdjsonMemoryStore(cwd, ".pi/memory");
    await store.ensureReady();
    for (let i = 0; i < 8; i++)
      await store.remember("knowledge", `common knowledge ${i}`);
    const target = (await store.remember("decisions", "common target")).memory;
    const manager = new MemoryManager(cwd, {
      semanticEnabled: true,
      embeddingDimensions: 2,
      embeddingProvider: fake,
    });
    try {
      const result = await manager.recall({
        query: "common",
        category: "decisions",
        limit: 1,
      });
      assert.equal(result.memories.length, 1);
      assert.equal(result.memories[0].id, target.id);
      assert.equal(result.searchMode, "semantic");
    } finally {
      await manager.close();
    }
    const failing = {
      ...fake,
      embedBatch: async (_texts: string[]) => {
        throw new Error("offline");
      },
    };
    const fallback = new MemoryManager(cwd, {
      semanticEnabled: true,
      embeddingDimensions: 2,
      embeddingProvider: failing,
    });
    try {
      await store.update(target.id, "fresh fallback term");
      const result = await fallback.recall({
        query: "fresh",
        category: "decisions",
      });
      assert.equal(result.memories[0].id, target.id);
      assert.notEqual(result.searchMode, "semantic");
      assert.equal(
        (await fallback.recall({ query: "target", category: "decisions" }))
          .memories.length,
        0,
      );
    } finally {
      await fallback.close();
    }
  });
});

test("manual edit during delayed embedding is retried before publishing", async () => {
  await fixture(async (cwd) => {
    const store = new NdjsonMemoryStore(cwd, ".pi/memory");
    await store.ensureReady();
    const item = (await store.remember("knowledge", "stale token")).memory;
    const file = join(cwd, ".pi/memory/knowledge.ndjson");
    let calls = 0;
    const provider = {
      ...fake,
      embedBatch: async (texts: string[]) => {
        if (calls++ === 0)
          await writeFile(
            file,
            `${JSON.stringify({ ...item, content: "fresh token" })}\n`,
          );
        return texts.map(() => [1, 0]);
      },
    };
    const manager = new MemoryManager(cwd, {
      semanticEnabled: true,
      embeddingDimensions: 2,
      embeddingProvider: provider,
    });
    try {
      const result = await manager.recall({ query: "fresh" });
      assert.equal(result.memories[0].content, "fresh token");
      assert.ok(calls >= 2);
      const contents = await readFile(file, "utf8");
      assert.ok(contents.includes("fresh token"));
    } finally {
      await manager.close();
    }
  });
});

test("recall recovers interrupted moves before reconciling the index", async () => {
  await fixture(async (cwd) => {
    const manager = new MemoryManager(cwd, { semanticEnabled: false });
    try {
      const item = (await manager.remember("knowledge", "interrupted comet"))
        .memory;
      const store = new NdjsonMemoryStore(
        cwd,
        ".pi/memory",
        undefined,
        async (phase) => {
          if (phase === "destination") throw new Error("interrupted");
        },
      );
      const expected = (await store.captureMovePrecondition(item.id))!;
      await assert.rejects(store.move(expected, "decisions"), /interrupted/);
      assert.equal(
        (await manager.recall({ query: "comet", category: "knowledge" }))
          .memories.length,
        0,
      );
      assert.equal(
        (await manager.recall({ query: "comet", category: "decisions" }))
          .memories[0].id,
        item.id,
      );
    } finally {
      await manager.close();
    }
  });
});

test("independent process writes are reconciled by an already initialized manager", async () => {
  await fixture(async (cwd) => {
    const manager = new MemoryManager(cwd, { semanticEnabled: false });
    try {
      await manager.initialize();
      const script = `import { MemoryManager } from ${JSON.stringify(moduleUrl)}; const m = new MemoryManager(process.argv[1], { semanticEnabled:false }); await m.remember('decisions','child unique term'); await m.close();`;
      const proc = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          script,
          cwd,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const [code] = await once(proc, "exit");
      assert.equal(code, 0, stderr);
      const result = await manager.recall({
        query: "unique",
        category: "decisions",
      });
      assert.equal(result.memories.length, 1);
      assert.equal(result.memories[0].content, "child unique term");
    } finally {
      await manager.close();
    }
  });
});
