import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { NdjsonMemoryStore, MemoryManager } from "./core.ts";

const moduleUrl = new URL("./core.ts", import.meta.url).href;
const dbUrl = import.meta.resolve("better-sqlite3");

async function fixture(
  run: (cwd: string, store: NdjsonMemoryStore) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "memory-safety-"));
  try {
    const store = new NdjsonMemoryStore(cwd, ".pi/memory");
    await store.ensureReady();
    await run(cwd, store);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function child(script: string, cwd: string) {
  return spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script, cwd],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}
async function success(process: ReturnType<typeof child>) {
  let error = "";
  process.stderr!.on("data", (data) => {
    error += data;
  });
  const [code] = await once(process, "exit");
  assert.equal(code, 0, error);
}

test("independent processes serialize writes and recover a killed lock owner", async () => {
  await fixture(async (cwd, store) => {
    const owner = child(
      `import Database from ${JSON.stringify(dbUrl)}; const db = new Database(process.argv[1] + '/.pi/memory/write-lock.db'); db.exec('BEGIN IMMEDIATE'); console.log('locked'); setInterval(() => {}, 1000);`,
      cwd,
    );
    await once(owner.stdout!, "data");
    const jobs = Array.from({ length: 4 }, (_, i) =>
      child(
        `import { NdjsonMemoryStore } from ${JSON.stringify(moduleUrl)}; const s = new NdjsonMemoryStore(process.argv[1], '.pi/memory'); for (let n=0;n<10;n++) await s.remember('knowledge', '${i}-' + n);`,
        cwd,
      ),
    );
    owner.kill("SIGKILL");
    await once(owner, "exit");
    await Promise.all(jobs.map(success));
    const items = await store.list();
    assert.equal(items.length, 40);
    const updates = items
      .slice(0, 4)
      .map((item, i) =>
        child(
          `import { NdjsonMemoryStore } from ${JSON.stringify(moduleUrl)}; const s = new NdjsonMemoryStore(process.argv[1], '.pi/memory'); await s.update(${JSON.stringify(item.id)}, 'updated-${i}');`,
          cwd,
        ),
      );
    await Promise.all(updates.map(success));
    const after = await store.list();
    for (let i = 0; i < 4; i++)
      assert.equal(
        after.find((item) => item.id === items[i].id)?.content,
        `updated-${i}`,
      );
  });
});

test("external edits before rename conflict and remain intact", async () => {
  await fixture(async (cwd, store) => {
    const item = (await store.remember("knowledge", "original")).memory;
    const file = join(cwd, ".pi/memory/knowledge.ndjson");
    const expected = (await store.captureWritePrecondition(item.id))!;
    const edited = `${JSON.stringify({ ...item, content: "manual" })}\n`;
    const racing = new NdjsonMemoryStore(cwd, ".pi/memory", async () =>
      writeFile(file, edited),
    );
    await assert.rejects(racing.update(item.id, "changed"), /conflict/);
    assert.equal(await readFile(file, "utf8"), edited);
    await assert.rejects(
      store.update(item.id, "changed", expected),
      /conflict/,
    );
    await assert.rejects(store.forget(item.id, expected), /conflict/);
  });
});

test("malformed and duplicate lines block mutation; repair is explicit and preserves valid bytes", async () => {
  await fixture(async (cwd, store) => {
    const item = (await store.remember("knowledge", "original")).memory;
    const file = join(cwd, ".pi/memory/knowledge.ndjson");
    const valid = `  ${JSON.stringify({ ...item, extra: 1 })}  \r\n`;
    await writeFile(file, valid + "bad\n");
    const manager = new MemoryManager(cwd, { semanticEnabled: false });
    try {
      await manager.initialize();
      assert.equal(await readFile(file, "utf8"), valid + "bad\n");
      await assert.rejects(store.forget(item.id), /malformed/);
      assert.equal((await manager.repair()).totalRemovedLines, 1);
      assert.equal(await readFile(file, "utf8"), valid);
      await writeFile(file, valid + valid);
      await assert.rejects(store.update(item.id, "new"), /duplicate/);
      assert.equal(await readFile(file, "utf8"), valid + valid);
    } finally {
      await manager.close();
    }
  });
});
