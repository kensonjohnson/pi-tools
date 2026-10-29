import { test } from "node:test";
import assert from "node:assert/strict";
import { captureScreenshot } from "./screenshots.ts";
import { ArtifactStore } from "./artifacts.ts";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("cancellation during artifact publication reports uncertainty and omits late data", async () => {
  let release!: (value: any) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(10, 16);
  png.writeUInt32BE(10, 20);
  const page = {
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({
          cssLayoutViewport: { clientWidth: 10, clientHeight: 10 },
        }),
        detach: async () => {},
      }),
    }),
    screenshot: async () => png,
  };
  const artifacts = {
    putBinary: () => {
      entered();
      return pending;
    },
  };
  const controller = new AbortController();
  let quarantined = false;
  const operation = captureScreenshot({
    page: page as never,
    artifacts: artifacts as never,
    owner: "one",
    scope: "viewport",
    signal: controller.signal,
    quarantine: () => {
      quarantined = true;
    },
  });
  await started;
  controller.abort();
  await assert.rejects(operation, /artifact may have been published/);
  assert(quarantined);
  release({ id: "late", path: "/private", bytes: 24, expiresAt: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("real artifact store lock warnings and errors preserve recovery guidance without paths", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "screenshot-private-")),
  );
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(10, 16);
  png.writeUInt32BE(10, 20);
  const page = {
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({
          cssLayoutViewport: { clientWidth: 10, clientHeight: 10 },
        }),
        detach: async () => {},
      }),
    }),
    screenshot: async () => png,
  };
  const run = (artifacts: ArtifactStore) =>
    captureScreenshot({
      page: page as never,
      artifacts,
      owner: "one",
      scope: "viewport",
      quarantine: () => {},
    });
  const releaseLock = async () => {
    throw new Error(`secret ${root}`);
  };
  try {
    const ok = await run(
      new ArtifactStore({
        root: join(root, "success"),
        releaseLock: releaseLock as never,
      }),
    );
    const text = ok.content[0].text!;
    const meta = JSON.parse(text);
    assert.match(meta.artifact.warning, /saved.*lock cleanup failed.*manually/);
    assert(!text.includes(root));
    assert.equal(meta.artifact.path, undefined);
    const quotaStore = new ArtifactStore({
      root: join(root, "failure"),
      quota: 1,
      releaseLock: releaseLock as never,
    });
    await assert.rejects(run(quotaStore), (error: Error) => {
      assert.match(
        error.message,
        /quota exceeded.*lock cleanup failed.*inspect/i,
      );
      assert(!error.message.includes(root));
      assert.equal(error.cause, undefined);
      return true;
    });
    const broken = new ArtifactStore({
      root: join(root, "recovery"),
      quota: 1,
      publication: {
        unlink: (async () => {
          throw new Error(`private ${root}`);
        }) as never,
      },
    });
    await assert.rejects(run(broken), (error: Error) => {
      assert.match(
        error.message,
        /recovery could not be verified.*lock was retained.*inspect/i,
      );
      assert(!error.message.includes(root));
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
