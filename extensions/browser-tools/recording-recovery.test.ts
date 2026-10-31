import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createRecordingDirectory,
  listRecordingRecovery,
} from "./recording-recovery.ts";

test(
  "recovery paginates past ten thousand matching directories",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-scan-cap-test-"));
    const moduleUrl = new URL("./recording-recovery.ts", import.meta.url).href;
    try {
      const script = `import { mkdirSync } from 'node:fs'; import {createHash} from 'node:crypto'; import {join} from 'node:path'; import {listRecordingRecovery} from ${JSON.stringify(moduleUrl)}; const key = createHash('sha256').update('owner').digest('hex'); for (let i=0;i<10002;i++) mkdirSync(join(process.env.TMPDIR, 'pi-browser-video-'+key+'-'+i.toString(36).padStart(6,'0')), {mode:0o700}); const page = await listRecordingRecovery('owner',10000,1); const controller = new AbortController(); setTimeout(() => controller.abort(), 1); let cancelled = false; try { await listRecordingRecovery('owner',10000,1,controller.signal); } catch (error) { cancelled = /cancelled/.test(String(error)); } console.log(JSON.stringify({...page,cancelled}));`;
      const child = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", script],
        {
          encoding: "utf8",
          timeout: 25000,
          env: { ...process.env, TMPDIR: root },
        },
      );
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout);
      assert.ok(result.scanned > 10000);
      assert.equal(result.items.length, 1);
      assert.equal(result.truncated, true);
      assert.equal(result.nextOffset, 10001);
      assert.equal(result.cancelled, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("recovery discovers a private directory after abrupt creator death", async () => {
  const owner = randomUUID();
  const moduleUrl = new URL("./recording-recovery.ts", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import {createRecordingDirectory} from ${JSON.stringify(moduleUrl)}; const dir = await createRecordingDirectory("video", ${JSON.stringify(owner)}); process.stdout.write(dir, () => process.kill(process.pid, "SIGKILL"));`,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(child.signal, "SIGKILL");
  const path = child.stdout;
  try {
    assert.ok(path);
    const result = await listRecordingRecovery(owner);
    assert.ok(result.items.some((item) => item.path === path));
    assert.equal((await lstat(path)).mode & 0o777, 0o700);
  } finally {
    if (path) await rm(path, { recursive: true, force: true });
  }
});

test("read-only recovery discovers owner-scoped live and retained directories without following symlinks", async () => {
  const owner = randomUUID(),
    other = randomUUID();
  const first = await createRecordingDirectory("trace", owner);
  const second = await createRecordingDirectory("video", owner);
  const privateOther = await createRecordingDirectory("trace", other);
  const unsafe = first.slice(0, -6) + "AAAAAA";
  try {
    await symlink(first, unsafe);
    const page = await listRecordingRecovery(owner, 0, 1);
    assert.equal(page.items.length, 1);
    assert.equal(page.nextOffset, 1);
    const all = await listRecordingRecovery(owner, 0, 20);
    assert.deepEqual(
      new Set(all.items.map((item) => item.path)),
      new Set([first, second]),
    );
    assert.equal(all.unsafeEntries, 1);
    assert.ok(all.notice.includes("may still be using"));
    assert.equal((await lstat(first)).isDirectory(), true);
    assert.equal((await lstat(privateOther)).isDirectory(), true);
    const alien = await listRecordingRecovery(other);
    assert.deepEqual(
      alien.items.map((item) => item.path),
      [privateOther],
    );
  } finally {
    await rm(unsafe, { force: true });
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
    await rm(privateOther, { recursive: true, force: true });
  }
});
