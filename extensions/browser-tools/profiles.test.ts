import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  symlink,
  mkdir,
  writeFile,
  link,
  stat,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fork } from "node:child_process";
import { once } from "node:events";
import { acquireProfile } from "./profiles.ts";

async function fixture() {
  return mkdtemp(join(tmpdir(), "browser-profile-test-"));
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test("leases serialize factories, cancellation and deadlines do not release the owner", async () => {
  const root = await fixture();
  try {
    const first = await acquireProfile("shared", { root });
    const abort = new AbortController();
    const waiting = acquireProfile("shared", { root, signal: abort.signal });
    await pause(120);
    abort.abort();
    await assert.rejects(waiting, /cancelled/);
    await assert.rejects(
      acquireProfile("shared", { root, timeoutMs: 150 }),
      /timed out/,
    );
    const next = acquireProfile("shared", { root, timeoutMs: 2000 });
    await first.release();
    const second = await next;
    await first.release();
    await assert.rejects(
      acquireProfile("shared", { root, timeoutMs: 150 }),
      /timed out/,
    );
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("same-process waiter cannot drop SQLite lock seen by a separate process", async () => {
  const root = await fixture();
  const owner = await acquireProfile("shared", { root });
  const marker = join(root, "lease-shared.pending");
  const original = await readFile(marker, "utf8");
  let localAcquired = false,
    childAcquired = false;
  let local: Awaited<ReturnType<typeof acquireProfile>> | undefined;
  const localWait = acquireProfile("shared", { root, timeoutMs: 5000 }).then(
    (lease) => {
      local = lease;
      localAcquired = true;
      return "local" as const;
    },
  );
  const child = fork(
    new URL("./profile-test-helper.mjs", import.meta.url),
    [root],
    {
      execArgv: ["--experimental-strip-types"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const childWait = once(child, "message").then(() => {
    childAcquired = true;
    return "child" as const;
  });
  void localWait.catch(() => {});
  void childWait.catch(() => {});
  try {
    await pause(600);
    assert.equal(child.exitCode, null, stderr);
    assert.equal(childAcquired, false);
    assert.equal(localAcquired, false);
    assert.equal(await readFile(marker, "utf8"), original);
    await owner.release();
    const winner = await Promise.race([localWait, childWait]);
    if (winner === "local") {
      assert.equal(childAcquired, false);
      await local!.release();
      await childWait;
      child.send("release");
      await once(child, "exit");
    } else {
      assert.equal(localAcquired, false);
      child.send("release");
      await once(child, "exit");
      await localWait;
      await local!.release();
    }
  } finally {
    await owner.release();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await localWait.catch(() => {});
    await local?.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("independent processes contend and a crashed owner leaves an unresolved marker", async () => {
  const root = await fixture();
  const helper = new URL("./profile-test-helper.mjs", import.meta.url);
  const child = fork(helper, [root], {
    execArgv: ["--experimental-strip-types"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  try {
    await once(child, "message");
    await assert.rejects(
      acquireProfile("shared", { root, timeoutMs: 150 }),
      /timed out/,
    );
    child.kill("SIGKILL");
    await once(child, "exit");
    assert.match(
      await readFile(join(root, "lease-shared.pending"), "utf8"),
      /nonce/,
    );
    await assert.rejects(
      acquireProfile("shared", { root }),
      /ownership is unresolved/,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
test("rejects traversal and symlinked profile directories", async () => {
  const root = await fixture();
  try {
    await assert.rejects(acquireProfile("../bad", { root }), /Invalid profile/);
    await mkdir(join(root, "target"));
    await symlink(join(root, "target"), join(root, "profile-bad"));
    await assert.rejects(acquireProfile("bad", { root }), /owned directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("nested symlinks and hard links are rejected before profile use", async () => {
  const root = await fixture();
  const outside = await fixture();
  try {
    const profile = join(root, "profile-shared");
    await mkdir(profile);
    await symlink(outside, join(profile, "Default"));
    await assert.rejects(
      acquireProfile("shared", { root }),
      /Unsafe profile entry/,
    );
    assert.deepEqual(
      await (await import("node:fs/promises")).readdir(outside),
      [],
    );
    await rm(join(profile, "Default"));
    await mkdir(join(profile, "Default"));
    await writeFile(join(outside, "external"), "unchanged");
    await link(join(outside, "external"), join(profile, "Default", "Cookies"));
    await assert.rejects(acquireProfile("shared", { root }), /hard link/);
    assert.equal(
      await readFile(join(outside, "external"), "utf8"),
      "unchanged",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
test("hard-linked lock database and SQLite sidecars are rejected without modifying the external file", async () => {
  const root = await fixture();
  const outside = await fixture();
  try {
    const external = join(outside, "external");
    await writeFile(external, "untouched");
    await chmod(external, 0o644);
    const lock = join(root, "lease-shared.sqlite");
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      await link(external, lock + suffix);
      await assert.rejects(
        acquireProfile("shared", { root }),
        /Unsafe profile lock metadata/,
      );
      assert.equal((await stat(external)).mode & 0o777, 0o644);
      assert.equal(await readFile(external, "utf8"), "untouched");
      await rm(lock + suffix);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
test("symlinked SQLite metadata is rejected without modifying its target", async () => {
  const root = await fixture();
  const outside = await fixture();
  try {
    const target = join(outside, "target");
    await writeFile(target, "safe");
    await chmod(target, 0o644);
    const lock = join(root, "lease-shared.sqlite");
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      await symlink(target, lock + suffix);
      await assert.rejects(
        acquireProfile("shared", { root }),
        /Unsafe profile lock metadata/,
      );
      assert.equal((await stat(target)).mode & 0o777, 0o644);
      assert.equal(await readFile(target, "utf8"), "safe");
      await rm(lock + suffix);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
test("a marker naming a reused or live PID is never auto-recovered", async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, "lease-shared.pending"),
      JSON.stringify({ version: 1, pid: process.pid, nonce: "old-owner" }),
      { mode: 0o600 },
    );
    await assert.rejects(
      acquireProfile("shared", { root }),
      /ownership is unresolved/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("release refuses a replaced ownership nonce", async () => {
  const root = await fixture();
  try {
    const lease = await acquireProfile("shared", { root });
    await writeFile(
      join(root, "lease-shared.pending"),
      JSON.stringify({ pid: process.pid, nonce: "different" }),
    );
    await assert.rejects(lease.release(), /marker changed/);
    await assert.rejects(
      acquireProfile("shared", { root }),
      /ownership is unresolved/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("abandoned leases and unknown PID markers never auto-recover", async () => {
  const root = await fixture();
  try {
    const lease = await acquireProfile("shared", { root });
    lease.abandon();
    await assert.rejects(
      acquireProfile("shared", { root, timeoutMs: 100 }),
      /timed out/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
