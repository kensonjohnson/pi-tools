import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { ArtifactStore } from "./artifacts.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceRecordings } from "./recording.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(
  options: {
    durationMs?: number;
    timeoutMs?: number;
    fail?: boolean;
    hang?: boolean;
    quota?: number;
  } = {},
) {
  const published: { owner: string; data: Buffer }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context = {
    tracing: {
      start: async () => {},
      stop: async ({ path }: { path: string }) => {
        if (options.hang) await gate;
        if (options.fail) throw new Error("native error");
        await writeFile(path, "trace bytes");
      },
    },
  };
  const recordings = new TraceRecordings({
    durationMs: options.durationMs ?? 10000,
    timeoutMs: options.timeoutMs ?? 1000,
    maxBytes: options.quota ?? 100,
    sink: {
      async putBinary(owner, stream, opts) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > opts.maxBytes) throw new Error("quota");
          chunks.push(Buffer.from(chunk));
        }
        published.push({ owner, data: Buffer.concat(chunks) });
        return { id: "artifact", path: "private", bytes: size, expiresAt: 1 };
      },
    },
  });
  return { context: context as never, recordings, published, release };
}
test("trace is creator scoped and published only after native stop", async () => {
  const { recordings, context, published } = fixture();
  assert.equal(
    (await recordings.start("s", "alice", context)).state,
    "recording",
  );
  assert.throws(() => recordings.inspect("s", "bob"), /unavailable/);
  await assert.rejects(
    recordings.start("s", "alice", context),
    /already exists/,
  );
  assert.equal(published.length, 0);
  const done = await recordings.stop("s", "alice");
  assert.equal(done.state, "complete");
  assert.deepEqual(published, [
    { owner: "alice", data: Buffer.from("trace bytes") },
  ]);
  assert.equal(done.artifact?.id, "artifact");
});
test("deadline finalizes and quota or native failures never claim publication", async () => {
  const a = fixture({ durationMs: 10 });
  await a.recordings.start("s", "alice", a.context);
  await wait(60);
  assert.equal(a.recordings.inspect("s", "alice").state, "complete");
  for (const opts of [{ fail: true }, { quota: 1 }]) {
    const f = fixture(opts);
    await f.recordings.start("s", "alice", f.context);
    const record = await f.recordings.stop("s", "alice");
    assert.equal(record.state, "failed");
    assert.equal(record.artifact, undefined);
    assert.equal(f.published.length, 0);
    assert.ok(record.recoveryDirectory);
    await rm(record.recoveryDirectory, { recursive: true, force: true });
  }
});
test("hung native start rejects by deadline and a late start is not claimed stopped", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stops = 0;
  const manager = new TraceRecordings({
    durationMs: 10,
    timeoutMs: 20,
    maxBytes: 100,
    sink: {
      async putBinary() {
        throw new Error("sink rejected");
      },
    },
  });
  const context = {
    tracing: {
      start: async () => {
        await gate;
      },
      stop: async () => {
        stops++;
        throw new Error("native stop failed");
      },
    },
  };
  await assert.rejects(
    manager.start("hung", "owner", context as never),
    /start deadline/,
  );
  assert.equal(manager.inspect("hung", "owner").state, "unknown");
  assert.equal(stops, 0);
  await wait(30);
  assert.equal(stops, 0);
  release();
  await wait(30);
  assert.equal(stops, 1);
  const record = manager.inspect("hung", "owner");
  assert.equal(record.state, "failed");
  assert.ok(record.recoveryDirectory);
  await rm(record.recoveryDirectory, { recursive: true, force: true });
});
test("sink rejection before consuming a missing trace never emits an unhandled stream error", async () => {
  const store = new ArtifactStore({
    root: join(tmpdir(), `missing-recording-parent-${Date.now()}`, "store"),
  });
  const manager = new TraceRecordings({
    sink: store,
    durationMs: 10000,
    timeoutMs: 1000,
    maxBytes: 100,
  });
  const context = { tracing: { start: async () => {}, stop: async () => {} } };
  await manager.start("missing", "owner", context as never);
  const record = await manager.stop("missing", "owner");
  assert.equal(record.state, "failed");
  await wait(50);
  assert.ok(record.recoveryDirectory);
  await rm(record.recoveryDirectory, { recursive: true, force: true });
});
test("timed out native finalization is unknown until it actually settles", async () => {
  const f = fixture({ hang: true, timeoutMs: 20 });
  await f.recordings.start("s", "alice", f.context);
  await assert.rejects(f.recordings.stop("s", "alice"), /deadline exceeded/);
  assert.equal(f.recordings.inspect("s", "alice").state, "unknown");
  f.release();
  await wait(30);
  assert.equal(f.recordings.inspect("s", "alice").state, "complete");
});
