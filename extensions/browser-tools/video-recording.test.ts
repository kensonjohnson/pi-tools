import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { ArtifactStore } from "./artifacts.ts";
import { join } from "node:path";
import { VideoRecordings } from "./video-recording.ts";

const WEBM_FIXTURE = Buffer.concat([
  Buffer.from(
    "1a45dfa3874282847765626d18538067a01654ae6b8cae8a8381018685",
    "hex",
  ),
  Buffer.from("V_VP9"),
  Buffer.from("1f43b6758ae78100a3858100008000", "hex"),
]);

function fixture(
  options: {
    quota?: number;
    durationMs?: number;
    timeoutMs?: number;
    hang?: boolean;
  } = {},
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const videos = new VideoRecordings({
    durationMs: options.durationMs ?? 10000,
    timeoutMs: options.timeoutMs ?? 1000,
    maxBytes: options.quota ?? 100,
    sink: {
      async putBinary(_owner, stream, opts) {
        if (options.hang) await gate;
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > opts.maxBytes) throw new Error("quota");
        }
        return { id: "file", path: "private", bytes: size, expiresAt: 1 };
      },
    },
  });
  const context = Object.assign(new EventEmitter(), { pages: () => [] });
  return { videos, context, release };
}
test("private video publication is owner scoped and happens only after close", async () => {
  const f = fixture();
  const dir = await f.videos.prepare("s", "alice");
  try {
    assert.equal((await lstat(dir)).mode & 0o777, 0o700);
    const path = join(dir, "a.webm");
    await writeFile(path, WEBM_FIXTURE);
    f.videos.attach("s", "alice", f.context as never, () => {});
    f.context.emit("page", { video: () => ({ path: async () => path }) });
    assert.equal(f.videos.inspect("s", "alice").videos[0].state, "pending");
    assert.throws(() => f.videos.inspect("s", "bob"), /unavailable/);
    assert.equal(await f.videos.closed("s", "alice"), true);
    assert.equal(f.videos.inspect("s", "alice").videos[0].state, "complete");
    await assert.rejects(lstat(dir), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("quota and unexpected files preserve recovery directory", async () => {
  for (const extra of [false, true]) {
    const f = fixture({ quota: extra ? 100 : 1 });
    const dir = await f.videos.prepare("s", "alice");
    try {
      const path = join(dir, "a.webm");
      await writeFile(path, WEBM_FIXTURE);
      if (extra) await writeFile(join(dir, "other"), "keep");
      f.videos.attach("s", "alice", f.context as never, () => {});
      f.context.emit("page", { video: () => ({ path: async () => path }) });
      assert.equal(await f.videos.closed("s", "alice"), false);
      const record = f.videos.inspect("s", "alice");
      assert.equal(record.state, "failed");
      assert.equal(record.recoveryDirectory, dir);
      assert.ok((await readdir(dir)).length);
    } finally {
      await chmod(dir, 0o700);
      await rm(dir, { recursive: true, force: true });
    }
  }
});
test("empty and malformed native videos are not published and stay recoverable", async () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from("not a video"),
    Buffer.alloc(512, 0x41),
    WEBM_FIXTURE.subarray(0, WEBM_FIXTURE.length - 1),
    Buffer.concat([
      Buffer.from("1a45dfa34282847765626d185380671654ae6b", "hex"),
      Buffer.from("V_VP9"),
      Buffer.from("1f43b67500000000", "hex"),
    ]),
  ]) {
    const f = fixture();
    const dir = await f.videos.prepare("s", "alice");
    try {
      const path = join(dir, "a.webm");
      await writeFile(path, bytes);
      f.videos.attach("s", "alice", f.context as never, () => {});
      f.context.emit("page", { video: () => ({ path: async () => path }) });
      assert.equal(await f.videos.closed("s", "alice"), false);
      const record = f.videos.inspect("s", "alice");
      assert.equal(record.state, "failed");
      assert.equal(record.videos[0].artifact, undefined);
      assert.equal(record.recoveryDirectory, dir);
      assert.ok(await lstat(path));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
test("video path replacement cannot publish unrelated bytes or delete the replacement", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "video-inode-race-")),
  );
  const secret = join(root, "secret");
  await writeFile(secret, "PRIVATE_NOT_WEBM");
  const store = new ArtifactStore({ root: join(root, "store") });
  let path = "";
  const videos = new VideoRecordings({
    durationMs: 10000,
    timeoutMs: 1000,
    maxBytes: 1000,
    sink: {
      async putBinary(owner, data, options) {
        await rename(path, `${path}.original`);
        await symlink(secret, path);
        return store.putBinary(owner, data, options);
      },
    },
  });
  const context = Object.assign(new EventEmitter(), { pages: () => [] });
  const dir = await videos.prepare("s", "owner");
  try {
    path = join(dir, "video.webm");
    await writeFile(path, WEBM_FIXTURE);
    videos.attach("s", "owner", context as never, () => {});
    context.emit("page", { video: () => ({ path: async () => path }) });
    assert.equal(await videos.closed("s", "owner"), false);
    const record = videos.inspect("s", "owner");
    assert.equal(record.state, "failed");
    assert.equal(record.videos[0].artifact, undefined);
    assert.equal(record.recoveryDirectory, dir);
    assert.equal((await lstat(path)).isSymbolicLink(), true);
    assert.equal(await readFile(secret, "utf8"), "PRIVATE_NOT_WEBM");
    assert.equal(
      (await readdir(store.root)).some((name) => name.endsWith(".bin")),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
test("same-inode mutation during streaming rolls back publication", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "video-modify-race-")),
  );
  const store = new ArtifactStore({ root: join(root, "store") });
  let path = "";
  const videos = new VideoRecordings({
    durationMs: 10000,
    timeoutMs: 1000,
    maxBytes: 1000,
    sink: {
      async putBinary(owner, data, options) {
        async function* changed() {
          for await (const chunk of data) {
            await writeFile(path, Buffer.alloc(WEBM_FIXTURE.length, 0x42));
            yield chunk;
          }
        }
        return store.putBinary(owner, changed(), options);
      },
    },
  });
  const context = Object.assign(new EventEmitter(), { pages: () => [] });
  const dir = await videos.prepare("s", "owner");
  try {
    path = join(dir, "video.webm");
    await writeFile(path, WEBM_FIXTURE);
    videos.attach("s", "owner", context as never, () => {});
    context.emit("page", { video: () => ({ path: async () => path }) });
    assert.equal(await videos.closed("s", "owner"), false);
    const record = videos.inspect("s", "owner");
    assert.equal(record.state, "failed");
    assert.equal(record.videos[0].artifact, undefined);
    assert.equal(record.recoveryDirectory, dir);
    assert.equal(
      (await readdir(store.root)).some((name) => name.endsWith(".bin")),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
test("sink rejection before reading video cannot leave an unhandled stream error", async () => {
  let videoPath = "";
  const videos = new VideoRecordings({
    durationMs: 10000,
    timeoutMs: 1000,
    maxBytes: 100,
    sink: {
      async putBinary(_owner, _stream) {
        unlinkSync(videoPath);
        throw new Error("sink rejected");
      },
    },
  });
  const context = Object.assign(new EventEmitter(), { pages: () => [] });
  const dir = await videos.prepare("s", "owner");
  try {
    const path = join(dir, "video.webm");
    videoPath = path;
    await writeFile(path, WEBM_FIXTURE);
    videos.attach("s", "owner", context as never, () => {});
    context.emit("page", { video: () => ({ path: async () => path }) });
    assert.equal(await videos.closed("s", "owner"), false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(videos.inspect("s", "owner").state, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("deadline requests closure and hung publication stays unknown until settled", async () => {
  const f = fixture({ durationMs: 10, timeoutMs: 20, hang: true });
  const dir = await f.videos.prepare("s", "alice");
  try {
    const path = join(dir, "a.webm");
    await writeFile(path, WEBM_FIXTURE);
    let requested = 0;
    f.videos.attach("s", "alice", f.context as never, () => {
      requested++;
    });
    f.context.emit("page", { video: () => ({ path: async () => path }) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(requested, 1);
    assert.equal(await f.videos.closed("s", "alice"), false);
    assert.equal(f.videos.inspect("s", "alice").state, "unknown");
    f.release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.videos.inspect("s", "alice").state, "complete");
  } finally {
    f.release();
    await rm(dir, { recursive: true, force: true });
  }
});
