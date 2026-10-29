import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  DownloadManager,
  type BinaryArtifactSink,
  type NativeDownload,
} from "./downloads.ts";

function fixture(
  data: Buffer,
  options: { failure?: string; name?: string } = {},
) {
  let cancelled = false,
    deleted = false;
  const download: NativeDownload = {
    url: () => "https://example.test/file",
    suggestedFilename: () => options.name ?? "file.bin",
    failure: async () => options.failure ?? null,
    createReadStream: async () => Readable.from([data]),
    cancel: async () => {
      cancelled = true;
    },
    delete: async () => {
      deleted = true;
    },
  };
  return { download, cancelled: () => cancelled, deleted: () => deleted };
}
function sink(quota = Infinity) {
  const files = new Map<string, Buffer>();
  const adapter: BinaryArtifactSink = {
    async putBinary(owner, stream, { signal }) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > quota) throw new Error("quota exceeded");
        chunks.push(Buffer.from(chunk));
      }
      if (signal.aborted) throw new Error("aborted");
      const id = `${owner}-${files.size}`;
      files.set(id, Buffer.concat(chunks));
      return { id, path: `/private/${id}`, bytes: size, expiresAt: 123 };
    },
  };
  return { adapter, files };
}
const page = () => new EventEmitter();
const target = { sessionId: "owner", tabId: "tab" };

test("binary data, safe display names, ownership and session teardown", async () => {
  const store = sink(),
    manager = new DownloadManager({ sink: store.adapter }),
    p = page();
  manager.attach(target, p);
  const f = fixture(Buffer.from([0, 255, 12]), { name: "../../evil\\name\0" });
  f.download.url = () =>
    "https://user:pass@example.test/file?token=secret#frag";
  p.emit("download", f.download);
  const initial = manager.list("owner")[0];
  assert.doesNotMatch(initial.url, /user|pass|secret|frag/);
  assert.equal(initial.suggestedName, ".._.._evil_name_");
  assert.throws(() => manager.inspect("other", initial.id));
  const result = await manager.wait("owner", initial.id);
  assert.equal(result.state, "complete");
  assert.deepEqual(
    store.files.get(result.artifact!.id),
    Buffer.from([0, 255, 12]),
  );
  await manager.endSession("owner");
  assert.equal(p.listenerCount("download"), 0);
  assert.equal(store.files.size, 1);
  assert.equal(f.deleted(), true);
});

test("size, quota and native failures do not publish", async () => {
  for (const [adapter, maxBytes, fixtureOptions] of [
    [sink().adapter, 2, {}],
    [sink(1).adapter, 10, {}],
    [sink().adapter, 10, { failure: "network failed" }],
  ] as const) {
    const manager = new DownloadManager({ sink: adapter, maxBytes }),
      p = page();
    manager.attach(target, p);
    p.emit("download", fixture(Buffer.from("abc"), fixtureOptions).download);
    const result = await manager.wait("owner", manager.list("owner")[0].id);
    assert.equal(result.state, "failed");
    assert.equal(result.artifact, undefined);
    await manager.shutdown();
  }
});

test("cancel and waiter abort release listeners and session teardown waits", async () => {
  let finish!: (value: string | null) => void;
  const f = fixture(Buffer.from("a"));
  f.download.failure = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  f.download.cancel = async () => {
    finish("canceled");
  };
  const manager = new DownloadManager({ sink: sink().adapter, maxWaiters: 1 }),
    p = page();
  manager.attach(target, p);
  p.emit("download", f.download);
  const id = manager.list("owner")[0].id,
    abort = new AbortController();
  const waiter = manager.wait("owner", id, { signal: abort.signal });
  abort.abort();
  await assert.rejects(waiter, /cancelled/);
  const pending = manager.wait("owner", id);
  await manager.endSession("owner");
  assert.equal((await pending).state, "cancelled");
  assert.equal(f.deleted(), true);
});

test("session end waits even after publication while native deletion is pending", async () => {
  let release!: () => void;
  const f = fixture(Buffer.from("x"));
  f.download.delete = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const p = page(),
    manager = new DownloadManager({ sink: sink().adapter });
  manager.attach(target, p);
  p.emit("download", f.download);
  while (manager.list("owner")[0].state !== "complete")
    await new Promise((resolve) => setImmediate(resolve));
  let ended = false;
  const close = manager.endSession("owner").then(() => {
    ended = true;
  });
  const closeAgain = manager.endSession("owner");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false);
  release();
  await Promise.all([close, closeAgain]);
  assert.equal(ended, true);
});

test("excess concurrent downloads are cancelled", async () => {
  let finish!: (value: string | null) => void;
  const first = fixture(Buffer.from("a"));
  first.download.failure = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  first.download.cancel = async () => {
    finish("cancelled");
  };
  const second = fixture(Buffer.from("b"));
  const p = page(),
    manager = new DownloadManager({ sink: sink().adapter, maxActive: 1 });
  manager.attach(target, p);
  p.emit("download", first.download);
  p.emit("download", second.download);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.cancelled(), true);
  assert.equal(manager.list("owner").length, 1);
  assert.deepEqual(manager.saturation("owner"), {
    rejected: 1,
    evicted: 0,
    cleanupWarnings: 0,
    rejectionReasons: { activeLimit: 1, ownerLimit: 0, totalLimit: 0 },
    closedCleanup: null,
  });
  await manager.shutdown();
});
