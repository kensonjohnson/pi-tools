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
import { NdjsonMemoryStore } from "./core.ts";

async function fixture(
  run: (cwd: string, store: NdjsonMemoryStore) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "memory-write-safety-"));
  try {
    const store = new NdjsonMemoryStore(cwd, ".pi/memory");
    await store.ensureReady();
    await run(cwd, store);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("replacement preserves private permissions on remember update forget and repair", async () => {
  await fixture(async (cwd, store) => {
    const file = join(cwd, ".pi/memory/knowledge.ndjson");
    await chmod(file, 0o600);
    const check = async () =>
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    const item = (await store.remember("knowledge", "original")).memory;
    await check();
    await store.update(item.id, "changed");
    await check();
    await store.forget(item.id);
    await check();
    await writeFile(file, "broken\n");
    await store.repair();
    await check();
  });
});

test("proposal precondition detects extra field, whitespace, and deletion", async () => {
  await fixture(async (cwd, store) => {
    const item = (await store.remember("knowledge", "original")).memory;
    const file = join(cwd, ".pi/memory/knowledge.ndjson");
    const original = await readFile(file, "utf8");
    const expected = (await store.captureWritePrecondition(item.id))!;
    const changed = `${JSON.stringify({ ...JSON.parse(original), extra: "manual" })}\n`;
    await writeFile(file, changed);
    await assert.rejects(
      store.update(item.id, "changed", expected),
      /conflict/,
    );
    await assert.rejects(store.forget(item.id, expected), /conflict/);
    assert.equal(await readFile(file, "utf8"), changed);
    await writeFile(file, ` ${original}`);
    await assert.rejects(store.forget(item.id, expected), /conflict/);
    await writeFile(file, "");
    await assert.rejects(store.forget(item.id, expected), /deleted/);
  });
});

test("other category edits before commit conflict without losing either file", async () => {
  await fixture(async (cwd, store) => {
    const item = (await store.remember("knowledge", "original")).memory;
    const source = join(cwd, ".pi/memory/knowledge.ndjson");
    const other = join(cwd, ".pi/memory/decisions.ndjson");
    const original = await readFile(source, "utf8");
    const racing = new NdjsonMemoryStore(cwd, ".pi/memory", async () =>
      writeFile(other, original),
    );
    await assert.rejects(
      racing.update(item.id, "changed"),
      /decisions changed/,
    );
    assert.equal(await readFile(source, "utf8"), original);
    assert.equal(await readFile(other, "utf8"), original);
  });
});
