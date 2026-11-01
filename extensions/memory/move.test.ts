import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryManager, NdjsonMemoryStore } from "./core.ts";

async function fixture(
  run: (cwd: string, store: NdjsonMemoryStore) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "memory-move-"));
  try {
    const store = new NdjsonMemoryStore(cwd, ".pi/memory");
    await store.ensureReady();
    await run(cwd, store);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
const moduleUrl = new URL("./core.ts", import.meta.url).href;

test("move preserves id and raw extra fields, unrelated lines, and supports manager reads", async () => {
  await fixture(async (cwd, store) => {
    const item = (await store.remember("knowledge", "important")).memory;
    const source = join(cwd, ".pi/memory/knowledge.ndjson");
    const original = `  ${JSON.stringify({ ...item, extra: { human: true } })}  \r\n`;
    await writeFile(source, original);
    await store.remember("decisions", "existing");
    const manager = new MemoryManager(cwd, { semanticEnabled: false });
    try {
      const expected = (await manager.captureMovePrecondition(item.id))!;
      const moved = await manager.move(expected, "decisions");
      assert.equal(moved.id, item.id);
      assert.equal(moved.category, "decisions");
      assert.equal(await readFile(source, "utf8"), "");
      assert.ok(
        (
          await readFile(join(cwd, ".pi/memory/decisions.ndjson"), "utf8")
        ).endsWith(original),
      );
      assert.deepEqual(
        (await manager.list()).memories
          .filter((entry) => entry.id === item.id)
          .map((entry) => entry.category),
        ["decisions"],
      );
      assert.ok(
        !(await readdir(join(cwd, ".pi/memory/.runtime"))).some(
          (name) => name === "move-transaction.json" || name.endsWith(".tmp"),
        ),
      );
      await manager.recoverMove();
      await manager.recoverMove();
    } finally {
      await manager.close();
    }
  });
});

test("killed owner at each durable boundary is recovered idempotently", async () => {
  for (const phase of ["journal", "destination", "source"]) {
    await fixture(async (cwd, store) => {
      const item = (await store.remember("knowledge", `item ${phase}`)).memory;
      const script = `import { NdjsonMemoryStore } from ${JSON.stringify(moduleUrl)}; const s = new NdjsonMemoryStore(process.argv[1], '.pi/memory', undefined, async phase => { if (phase === ${JSON.stringify(phase)}) { console.log('checkpoint'); await new Promise(() => {}); } }); const p = await s.captureMovePrecondition(${JSON.stringify(item.id)}); await s.move(p, 'practices');`;
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
      await once(proc.stdout!, "data");
      proc.kill("SIGKILL");
      await once(proc, "exit");
      await store.recoverMove();
      await store.recoverMove();
      const list = await store.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, item.id);
      assert.equal(list[0].category, "practices");
      assert.ok(
        !(await readdir(join(cwd, ".pi/memory/.runtime"))).includes(
          "move-transaction.json",
        ),
      );
    });
  }
});

test("stale and competing proposals conflict without losing records", async () => {
  await fixture(async (cwd, store) => {
    const item = (await store.remember("knowledge", "important")).memory;
    const expected = (await store.captureMovePrecondition(item.id))!;
    const other = new NdjsonMemoryStore(cwd, ".pi/memory");
    const results = await Promise.allSettled([
      store.move(expected, "decisions"),
      other.move(expected, "practices"),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    const entries = await store.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, item.id);
    await assert.rejects(store.move(expected, "decisions"), /conflict/);
  });
});

test("manual edits during interrupted move and malformed journals fail closed", async () => {
  await fixture(async (cwd, store) => {
    const item = (await store.remember("knowledge", "important")).memory;
    const expected = (await store.captureMovePrecondition(item.id))!;
    const interrupted = new NdjsonMemoryStore(
      cwd,
      ".pi/memory",
      undefined,
      async (phase) => {
        if (phase === "destination") throw new Error("interrupted");
      },
    );
    await assert.rejects(
      interrupted.move(expected, "practices"),
      /interrupted/,
    );
    const source = join(cwd, ".pi/memory/knowledge.ndjson");
    const dest = join(cwd, ".pi/memory/practices.ndjson");
    const edit = `${JSON.stringify({ ...item, content: "manual" })}\n`;
    await writeFile(source, edit);
    const destBefore = await readFile(dest, "utf8");
    await assert.rejects(store.list(), /move conflict/i);
    await assert.rejects(store.recoverMove(), /move conflict/i);
    assert.equal(await readFile(source, "utf8"), edit);
    assert.equal(await readFile(dest, "utf8"), destBefore);
    const journal = join(cwd, ".pi/memory/.runtime/move-transaction.json");
    await writeFile(journal, "{bad");
    await assert.rejects(
      store.remember("decisions", "no"),
      /malformed or ambiguous/,
    );
    assert.equal(await readFile(source, "utf8"), edit);
    assert.equal(await readFile(dest, "utf8"), destBefore);
  });
});
