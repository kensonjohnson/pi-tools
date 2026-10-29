import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  DownloadManager,
  type NativeDownload,
  type BinaryArtifactSink,
} from "./downloads.ts";
const target = { sessionId: "s", tabId: "t" };
const sink: BinaryArtifactSink = {
  async putBinary(_owner, data) {
    for await (const _ of data) {
    }
    return { id: "a", path: "/private/a", bytes: 1, expiresAt: 123 };
  },
};
function native(): NativeDownload {
  return {
    url: () => "https://example.test",
    suggestedFilename: () => "a",
    failure: async () => null,
    createReadStream: async () => Readable.from([Buffer.from("x")]),
    cancel: async () => {},
    delete: async () => {},
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("completed entries are evicted with a count and capacity is reusable", async () => {
  const manager = new DownloadManager({ sink, maxRecords: 1 });
  const page = new EventEmitter();
  manager.attach(target, page);
  page.emit("download", native());
  const id = manager.list("s")[0].id;
  assert.equal((await manager.wait("s", id)).state, "complete");
  page.emit("download", native());
  assert.notEqual(manager.list("s")[0].id, id);
  assert.equal(manager.saturation("s").evicted, 1);
  assert.equal(manager.saturation("s").rejected, 0);
  await manager.shutdown();
});

test("endSession waits for rejected native cancel and delete", async () => {
  let release!: () => void;
  const first = native();
  first.failure = () => new Promise(() => {});
  const rejected = native();
  rejected.cancel = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  let deleted = false;
  rejected.delete = async () => {
    deleted = true;
  };
  const manager = new DownloadManager({
    sink,
    maxActive: 1,
    operationTimeoutMs: 300,
  });
  const page = new EventEmitter();
  manager.attach(target, page);
  page.emit("download", first);
  page.emit("download", rejected);
  await tick();
  let done = false;
  const close = manager.endSession("s").then((result) => {
    done = true;
    return result;
  });
  await tick();
  assert.equal(done, false);
  release();
  assert.deepEqual(await close, { cleanup: "complete", warnings: 0 });
  assert.equal(deleted, true);
});

test("native timeout and deletion failure are explicit and bounded", async () => {
  const f = native();
  f.failure = () => new Promise(() => {});
  f.cancel = () => new Promise(() => {});
  f.delete = async () => {
    throw new Error("delete failed");
  };
  const manager = new DownloadManager({ sink, operationTimeoutMs: 20 });
  const page = new EventEmitter();
  manager.attach(target, page);
  page.emit("download", f);
  const record = await manager.wait("s", manager.list("s")[0].id, {
    timeoutMs: 1000,
  });
  assert.equal(record.state, "failed");
  assert.match(record.failure!, /timed out/);
  assert.match(record.cleanupWarning!, /delete failed/);
  assert.equal((await manager.endSession("s")).cleanup, "unverified");
});

test("an uncooperative sink yields unknown publication rather than false failure", async () => {
  const manager = new DownloadManager({
    sink: { putBinary: async () => new Promise(() => {}) },
    operationTimeoutMs: 20,
  });
  const page = new EventEmitter();
  manager.attach(target, page);
  page.emit("download", native());
  const result = await manager.wait("s", manager.list("s")[0].id, {
    timeoutMs: 1000,
  });
  assert.equal(result.state, "unknown");
  assert.match(result.failure!, /publication may have occurred/);
  assert.equal((await manager.endSession("s")).cleanup, "unverified");
});

test("rejected cleanup overflow is bounded and reported unverified", async () => {
  const first = native();
  first.failure = () => new Promise(() => {});
  const stuck = () => {
    const n = native();
    n.cancel = () => new Promise(() => {});
    return n;
  };
  const manager = new DownloadManager({
    sink,
    maxActive: 1,
    maxRecords: 1,
    operationTimeoutMs: 20,
  });
  const page = new EventEmitter();
  manager.attach(target, page);
  page.emit("download", first);
  page.emit("download", stuck());
  page.emit("download", stuck());
  assert.equal(manager.saturation("s").rejected, 2);
  assert.equal((await manager.endSession("s")).cleanup, "unverified");
});
