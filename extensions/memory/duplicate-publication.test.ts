import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, NdjsonMemoryStore } from "./core.ts";

const moduleUrl = new URL("./core.ts", import.meta.url).href;
const data =
  '{"id":"x","content":"one","created":"t"}\n{"id":"x","content":"two","created":"t"}\n';
async function fixture(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "memory-publication-"));
  try {
    const store = new NdjsonMemoryStore(dir, "memory");
    await store.ensureReady();
    await writeFile(join(dir, "memory/knowledge.ndjson"), data);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
for (const phase of [
  "duplicate-written",
  "duplicate-synced",
  "duplicate-renamed",
  "duplicate-directory-synced",
]) {
  test(`SIGKILL at ${phase} leaves no partial published journal`, async () =>
    fixture(async (dir) => {
      const script = `import { NdjsonMemoryStore } from ${JSON.stringify(moduleUrl)}; const s = new NdjsonMemoryStore(process.argv[1], 'memory', undefined, async p => { if (p === process.argv[2]) { console.log('ready'); await new Promise(() => {}); } }); await s.resolveDuplicateIds();`;
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          script,
          dir,
          phase,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await once(child.stdout!, "data");
      child.kill("SIGKILL");
      await once(child, "exit");
      const store = new NdjsonMemoryStore(dir, "memory");
      const receipt = await store.listDuplicateIdResolutions();
      if (phase === "duplicate-written" || phase === "duplicate-synced") {
        assert.equal(receipt.length, 0);
        assert.equal((await store.resolveDuplicateIds()).changes.length, 1);
      } else {
        assert.equal(receipt.length, 1);
        assert.equal(receipt[0].changes.length, 1);
        assert.equal((await store.resolveDuplicateIds()).changes.length, 0);
      }
    }));
}
test("manager reconciles repair and exposes receipts after recovery during initialization", async () =>
  fixture(async (dir) => {
    const manager = new MemoryManager(dir, {
      memoryDirName: "memory",
      semanticEnabled: false,
    });
    await manager.initialize();
    assert.equal(manager.getWarnings().length, 1);
    const interrupted = new NdjsonMemoryStore(
      dir,
      "memory",
      undefined,
      async (phase) => {
        if (phase === "journal") throw Error("crash");
      },
    );
    await assert.rejects(interrupted.resolveDuplicateIds(), /crash/);
    await manager.list();
    assert.deepEqual(manager.getWarnings(), []);
    const receipts = await manager.listDuplicateIdResolutions();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].changes.length, 1);
    assert.equal(
      (await manager.recall({ query: "two" })).memories[0].id,
      receipts[0].changes[0].newId,
    );
    await manager.close();
  }));
