import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  readFile,
  readdir,
  symlink,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ArtifactStore } from "./artifacts.ts";
import { binaryChunkOutput } from "./output.ts";

const bytes = (data: Uint8Array) =>
  (async function* () {
    yield data;
  })();
async function fixture() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "binary-artifact-")),
  );
  return { parent, root: join(parent, "managed") };
}

test("binary retrieval uses exact byte offsets, base64, shared expiry and export", async () => {
  const { parent, root } = await fixture();
  try {
    let now = 1700000000000;
    const store = new ArtifactStore({ root, ttl: 100, now: () => now });
    const input = Buffer.from(Array.from({ length: 70001 }, (_, i) => i % 256));
    const item = await store.putBinary("owner", bytes(input), {
      maxBytes: input.length,
    });
    const chunks: Buffer[] = [];
    let offset = 0;
    do {
      const encoded = await binaryChunkOutput(
        store,
        "owner",
        item.id,
        offset,
        32768,
      );
      assert.ok(Buffer.byteLength(encoded) < 48 * 1024);
      const chunk = JSON.parse(encoded);
      assert.equal(chunk.encoding, "base64");
      assert.equal(chunk.offset, offset);
      const buffer = Buffer.from(chunk.data, "base64");
      assert.equal(buffer.length, chunk.chunkBytes);
      chunks.push(buffer);
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    } while (true);
    assert.deepEqual(Buffer.concat(chunks), input);
    await assert.rejects(store.read("owner", item.id), /Binary artifact/);
    await assert.rejects(store.readBinary("other", item.id), /unavailable/);
    const text = await store.put("owner", "text");
    await assert.rejects(store.readBinary("owner", text.id), /Text artifact/);
    const dest = join(parent, "export");
    await store.export("owner", item.id, dest);
    assert.deepEqual(await readFile(dest), input);
    now += 101;
    await assert.rejects(store.readBinary("owner", item.id), /expired/);
    assert.deepEqual(await readFile(dest), input);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("binary and text contend for one quota, stream errors and abort roll back", async () => {
  const { parent, root } = await fixture();
  try {
    const store = new ArtifactStore({ root, quota: 100 });
    const results = await Promise.allSettled([
      store.put("text", "a".repeat(60)),
      store.putBinary("binary", bytes(Buffer.alloc(60)), { maxBytes: 100 }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.match(
      String(
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
          .reason,
      ),
      /quota/,
    );
    const bad = async function* () {
      yield Buffer.alloc(5);
      throw new Error("stream fault");
    };
    await assert.rejects(
      store.putBinary("x", bad(), { maxBytes: 10 }),
      /stream fault/,
    );
    const ctl = new AbortController();
    const aborting = async function* () {
      yield Buffer.alloc(5);
      ctl.abort();
      yield Buffer.alloc(1);
    };
    await assert.rejects(
      store.putBinary("x", aborting(), { maxBytes: 10, signal: ctl.signal }),
      /cancelled/,
    );
    await assert.rejects(
      store.putBinary("x", bytes(Buffer.alloc(11)), { maxBytes: 10 }),
      /size limit/,
    );
    assert.equal(
      (await readdir(root)).filter((n) => n.startsWith(".tmp-")).length,
      0,
    );
    assert.equal((await store.cleanup()).count, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("binary file symlinks fail closed without modifying the target", async () => {
  const { parent, root } = await fixture();
  try {
    const store = new ArtifactStore({ root });
    const item = await store.putBinary("owner", bytes(Buffer.from([0, 255])), {
      maxBytes: 2,
    });
    const outside = join(parent, "outside");
    await writeFile(outside, "untouched");
    await rm(item.path);
    await symlink(outside, item.path);
    await assert.rejects(store.readBinary("owner", item.id));
    assert.equal(await readFile(outside, "utf8"), "untouched");
    assert.equal((await stat(outside)).size, 9);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("abort and timeout on an uncooperative iterator roll back without holding the store lock", async () => {
  const { parent, root } = await fixture();
  try {
    const store = new ArtifactStore({ root, quota: 100 });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            started();
            return new Promise<IteratorResult<Uint8Array>>(() => {});
          },
          return() {
            return new Promise<IteratorResult<Uint8Array>>(() => {});
          },
        };
      },
    };
    const controller = new AbortController();
    const pending = store.putBinary("owner", source, {
      maxBytes: 10,
      signal: controller.signal,
      sourceTimeoutMs: 1000,
      cleanupTimeoutMs: 20,
    });
    await entered;
    controller.abort();
    await assert.rejects(pending, /cancelled.*cleanup unverified/);
    assert.equal((await readdir(root)).length, 0);
    const text = await store.put("owner", "safe");
    assert.equal((await store.read("owner", text.id)).text, "safe");
    await assert.rejects(
      store.putBinary("owner", source, {
        maxBytes: 10,
        sourceTimeoutMs: 20,
        cleanupTimeoutMs: 20,
      }),
      /timed out.*cleanup unverified/,
    );
    assert.equal((await store.cleanup()).count, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("independent processes coordinate text and binary quota", async () => {
  const { parent, root } = await fixture();
  try {
    const helper = new URL("./artifact-binary-test-helper.mjs", import.meta.url)
      .pathname;
    const run = (kind: string) =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [helper, root, kind], {
          stdio: "ignore",
        });
        child.on("error", reject);
        child.on("exit", resolve);
      });
    const outcomes = await Promise.all([run("binary"), run("text")]);
    assert.deepEqual(outcomes.sort(), [0, 1]);
    assert.equal(
      (await new ArtifactStore({ root, quota: 100 }).cleanup()).bytes,
      60,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
