import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "./artifacts.ts";
import { DownloadManager } from "./downloads.ts";

const target = { sessionId: "s", tabId: "t" };
function fixture(bytes: Buffer) {
  let deleted = 0;
  return {
    deleted: () => deleted,
    download: {
      url: () => "https://example.test/file",
      suggestedFilename: () => "file.bin",
      failure: async () => null,
      createReadStream: async () => Readable.from([bytes]),
      cancel: async () => {},
      delete: async () => {
        deleted++;
      },
    },
  };
}
test("quota and disk publication failures retain native bytes for explicit no-overwrite export", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-recovery-")),
  );
  try {
    for (const [index, sink] of [
      new ArtifactStore({ root: join(root, "store"), quota: 2 }),
      {
        putBinary: async () => {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        },
      },
    ].entries()) {
      const manager = new DownloadManager({ sink });
      const page = new EventEmitter();
      manager.attach(target, page, "owner");
      const native = fixture(Buffer.from("secret"));
      page.emit("download", native.download);
      const id = manager.list("s")[0].id;
      const failed = await manager.wait("s", id);
      assert.equal(failed.state, "failed");
      assert.equal(failed.nativeRecovery, "available_until_session_close");
      assert.equal(native.deleted(), 0);
      const path = join(root, `export-${index}`);
      const exported = await manager.exportNative("s", id, path);
      assert.equal(exported.status, "complete");
      assert.equal(await readFile(path, "utf8"), "secret");
      await assert.rejects(manager.exportNative("s", id, path), /EEXIST/);
      assert.equal(await readFile(path, "utf8"), "secret");
      await manager.endSession("s");
      assert.equal(
        manager.inspect("s", id).nativeRecovery,
        "unknown_after_close",
      );
      await assert.rejects(
        manager.exportNative("s", id, join(root, "later")),
        /unavailable/,
      );
      assert.equal(native.deleted(), 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed artifacts remain discoverable to their owner after session close until expiry", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "download-closed-")),
  );
  try {
    const store = new ArtifactStore({ root: join(root, "store"), ttl: 1000 });
    const manager = new DownloadManager({ sink: store });
    const page = new EventEmitter();
    manager.attach(target, page, "owner");
    const native = fixture(Buffer.from("abc"));
    page.emit("download", native.download);
    const id = manager.list("s")[0].id;
    const complete = await manager.wait("s", id);
    assert.equal(complete.state, "complete");
    await manager.endSession("s");
    assert.equal(native.deleted(), 1);
    assert.equal(manager.owns("s", "owner"), true);
    assert.equal(manager.owns("s", "other"), false);
    assert.equal(manager.list("s")[0].artifact?.id, complete.artifact?.id);
    assert.equal(
      Buffer.from(
        (await store.readBinary("owner", complete.artifact!.id)).data,
        "base64",
      ).toString(),
      "abc",
    );
    await assert.rejects(
      store.readBinary("other", complete.artifact!.id),
      /owned by another/,
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepEqual(manager.list("s"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
