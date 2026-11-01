import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "./artifacts.ts";

test("artifact TTL begins when a long stream is published", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "download-ttl-")));
  let now = 1700000000000;
  const store = new ArtifactStore({
    root: join(root, "store"),
    ttl: 1000,
    now: () => now,
  });
  try {
    const artifact = await store.putBinary(
      "owner",
      (async function* () {
        yield Buffer.from("a");
        now += 5000;
        yield Buffer.from("b");
      })(),
      { maxBytes: 100 },
    );
    assert.equal(artifact.expiresAt, now + 1000);
    assert.equal((await store.readBinary("owner", artifact.id)).bytes, 2);
    const reopened = new ArtifactStore({
      root: join(root, "store"),
      ttl: 1000,
      now: () => now,
    });
    assert.equal((await reopened.list("owner")).artifacts[0].id, artifact.id);
    assert.deepEqual((await reopened.list("other")).artifacts, []);
    now += 1001;
    assert.deepEqual((await reopened.list("owner")).artifacts, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "long streaming publication permits cancellable download lock wait beyond five seconds",
  { timeout: 15000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "download-lock-")),
    );
    const store = new ArtifactStore({ root: join(root, "store") });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const signal = new AbortController();
    const source = async function* () {
      entered();
      await gate;
      yield Buffer.from("first");
    };
    let first: Promise<unknown> | undefined;
    try {
      const existing = await store.put("owner", "existing");
      first = store.putBinary("owner", source(), {
        maxBytes: 100,
        signal: signal.signal,
        sourceTimeoutMs: 0,
        lockWaitTimeoutMs: 0,
      });
      await started;
      let settled = false;
      const second = store
        .putBinary(
          "owner",
          (async function* () {
            yield Buffer.from("second");
          })(),
          {
            maxBytes: 100,
            signal: signal.signal,
            sourceTimeoutMs: 0,
            lockWaitTimeoutMs: 0,
          },
        )
        .finally(() => {
          settled = true;
        });
      const cancel = new AbortController();
      const third = store.putBinary(
        "owner",
        (async function* () {
          yield Buffer.from("third");
        })(),
        {
          maxBytes: 100,
          signal: cancel.signal,
          sourceTimeoutMs: 0,
          lockWaitTimeoutMs: 0,
        },
      );
      let readSettled = false;
      const read = store
        .read("owner", existing.id, 0, 65536, signal.signal)
        .finally(() => {
          readSettled = true;
        });
      const cancelledRead = store.read(
        "owner",
        existing.id,
        0,
        65536,
        cancel.signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 5200));
      assert.equal(settled, false);
      assert.equal(readSettled, false);
      const thirdCancelled = assert.rejects(third, /cancelled/);
      const readCancelled = assert.rejects(cancelledRead, /cancelled/);
      cancel.abort();
      await Promise.all([thirdCancelled, readCancelled]);
      release();
      await first;
      assert.equal((await second).bytes, 6);
      assert.equal((await read).text, "existing");
    } finally {
      release();
      signal.abort();
      await first?.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);
