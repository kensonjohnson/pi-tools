import { test } from "node:test";
import assert from "node:assert/strict";
import { ChromiumInstaller } from "./installer.ts";
import { ManagedSessions } from "./sessions.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("a failed launch creates no target and leaves cleanup unverified", async () => {
  const runtime = new ManagedSessions({
    launch: async () => {
      throw new Error("launch failed");
    },
  });
  await assert.rejects(
    runtime.start(),
    /cleanup could not be verified.*launch failed/s,
  );
  assert.deepEqual(runtime.list(), []);
  assert.equal((await runtime.shutdown()).complete, false);
});

test("sole cancelled install waiter aborts the runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-lifecycle-"));
  const started = deferred();
  const stopped = deferred();
  const controller = new AbortController();
  try {
    const installer = new ChromiumInstaller({
      platform: "darwin",
      lockPath: join(root, "lock.sqlite"),
      exists: async () => false,
      run: (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              stopped.resolve();
              reject(new Error("stopped"));
            },
            { once: true },
          );
          started.resolve();
        }),
    });
    const result = installer.ensure({
      trusted: true,
      autoInstall: true,
      signal: controller.signal,
    });
    await Promise.race([
      started.promise,
      result.then(() => {
        throw new Error("Install did not start");
      }),
    ]);
    controller.abort();
    assert.equal((await result).ok, false);
    await stopped.promise;
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("install deadline aborts its runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-lifecycle-"));
  const started = deferred();
  const stopped = deferred();
  const controller = new AbortController();
  try {
    const installer = new ChromiumInstaller({
      platform: "darwin",
      lockPath: join(root, "lock.sqlite"),
      exists: async () => false,
      run: (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              stopped.resolve();
              reject(new Error("stopped"));
            },
            { once: true },
          );
          started.resolve();
        }),
    });
    const result = installer.ensure({
      trusted: true,
      autoInstall: true,
      timeoutMs: 2000,
      signal: controller.signal,
    });
    await Promise.race([
      started.promise,
      result.then(() => {
        throw new Error("Install did not start before its deadline");
      }),
    ]);
    const outcome = await result;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.message, /deadline/);
    await stopped.promise;
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});
