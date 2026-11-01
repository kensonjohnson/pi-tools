import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NdjsonMemoryStore } from "./core.ts";

const moduleUrl = new URL("./core.ts", import.meta.url).href;
async function fixture(
  run: (cwd: string, store: NdjsonMemoryStore) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "memory-move-private-"));
  try {
    const store = new NdjsonMemoryStore(cwd, ".pi/memory");
    await store.ensureReady();
    await run(cwd, store);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("proposal snapshots reject changes in destination and unrelated category", async () => {
  for (const category of ["practices", "decisions"])
    await fixture(async (cwd, store) => {
      const item = (await store.remember("knowledge", "original")).memory;
      const expected = (await store.captureMovePrecondition(item.id))!;
      const file = join(cwd, `.pi/memory/${category}.ndjson`);
      const human = `${JSON.stringify({ id: `manual-${category}`, content: "manual edit", created: "today" })}\n`;
      await writeFile(file, human);
      await assert.rejects(
        store.move(expected, "practices"),
        /snapshots changed/,
      );
      assert.equal(await readFile(file, "utf8"), human);
      assert.equal(
        (await store.list()).filter((line) => line.id === item.id)[0].category,
        "knowledge",
      );
      assert.ok(
        !(await readdir(join(cwd, ".pi/memory/.runtime"))).includes(
          "move-transaction.json",
        ),
      );
    });
});

test("SIGKILL before rename leaves only private git-ignored temporary files, cleaned on recovery", async () => {
  await fixture(async (cwd, store) => {
    execFileSync("git", ["init", "-q"], { cwd });
    const item = (await store.remember("knowledge", "sensitive-memory-fixture"))
      .memory;
    const script = `import { NdjsonMemoryStore } from ${JSON.stringify(moduleUrl)}; const s = new NdjsonMemoryStore(process.argv[1], '.pi/memory', async () => { console.log('before-rename'); await new Promise(() => {}); }); const p = await s.captureMovePrecondition(${JSON.stringify(item.id)}); await s.move(p, 'decisions');`;
    const proc = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script, cwd],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await once(proc.stdout!, "data");
    proc.kill("SIGKILL");
    await once(proc, "exit");
    const runtime = join(cwd, ".pi/memory/.runtime");
    assert.equal((await stat(runtime)).mode & 0o777, 0o700);
    const files = await readdir(runtime);
    const tmp = files.find(
      (name) => name.startsWith("replace-") && name.endsWith(".tmp"),
    );
    assert.ok(tmp);
    assert.ok(
      (await readFile(join(runtime, tmp), "utf8")).includes(
        "sensitive-memory-fixture",
      ),
    );
    assert.equal(
      (await stat(join(runtime, "move-transaction.json"))).mode & 0o077,
      0,
    );
    for (const name of [tmp, "move-transaction.json"]) {
      execFileSync(
        "git",
        ["check-ignore", "-q", `.pi/memory/.runtime/${name}`],
        { cwd },
      );
    }
    await store.recoverMove();
    await store.recoverMove();
    assert.deepEqual(await readdir(runtime), [".gitignore"]);
    const records = await store.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].category, "decisions");
  });
});
