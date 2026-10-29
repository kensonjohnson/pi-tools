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
  "recovery explicitly reports when its scan limit truncates results",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-scan-cap-test-"));
    const moduleUrl = new URL("./recording-recovery.ts", import.meta.url).href;
    try {
      const script = `import { writeFileSync } from 'node:fs'; import {join} from 'node:path'; import {listRecordingRecovery, RECORDING_RECOVERY_SCAN_LIMIT as limit} from ${JSON.stringify(moduleUrl)}; for (let i=0;i<=limit;i++) writeFileSync(join(process.env.TMPDIR, 'entry-'+i), ''); console.log(JSON.stringify(await listRecordingRecovery('owner')));`;
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
      assert.equal(result.scanLimit, 10000);
      assert.equal(result.scanned, 10001);
      assert.equal(result.truncated, true);
      assert.equal(result.nextOffset, null);
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
