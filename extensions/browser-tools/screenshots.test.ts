import { test } from "node:test";
import assert from "node:assert/strict";
import { captureScreenshot, setScreenshotViewport } from "./screenshots.ts";

const limits = {
  maxDimension: 1000,
  maxPixels: 1000000,
  maxBytes: 1000000,
  timeoutMs: 50,
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("abort during native screenshot returns promptly and synchronously quarantines owner", async () => {
  const native = deferred<Buffer>();
  const entered = deferred<void>();
  let quarantined = 0,
    published = 0;
  const page = {
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({
          cssLayoutViewport: { clientWidth: 10, clientHeight: 10 },
        }),
        detach: async () => {},
      }),
    }),
    screenshot: () => {
      entered.resolve();
      return native.promise;
    },
  };
  const artifacts = {
    putBinary: async () => {
      published++;
      throw new Error("unexpected publication");
    },
  };
  const controller = new AbortController();
  const result = captureScreenshot({
    page: page as never,
    artifacts: artifacts as never,
    owner: "one",
    scope: "viewport",
    limits: { ...limits, timeoutMs: 1000 },
    signal: controller.signal,
    quarantine: () => {
      quarantined++;
    },
  });
  await entered.promise;
  controller.abort();
  await assert.rejects(
    result,
    /Native work may still be in flight.*artifact may have been published/,
  );
  assert.equal(quarantined, 1);
  native.resolve(Buffer.alloc(100));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(published, 0);
});

test("deadline covers hung preflight and viewport operation and quarantines once", async () => {
  const pending = deferred<any>();
  let quarantined = 0;
  const page = {
    context: () => ({ newCDPSession: () => pending.promise }),
    setViewportSize: () => pending.promise,
  };
  const quarantine = () => {
    quarantined++;
  };
  await assert.rejects(
    captureScreenshot({
      page: page as never,
      artifacts: {} as never,
      owner: "one",
      scope: "viewport",
      limits,
      quarantine,
    }),
    /timed out.*in flight/,
  );
  assert.equal(quarantined, 1);
  await assert.rejects(
    setScreenshotViewport(
      page as never,
      { width: 100, height: 100 },
      limits,
      undefined,
      quarantine,
    ),
    /timed out.*in flight/,
  );
  assert.equal(quarantined, 2);
  let sent = false,
    detached = false;
  pending.resolve({
    send: async () => {
      sent = true;
    },
    detach: async () => {
      detached = true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent, false);
  assert.equal(detached, true);
});

test("a missing quarantine callback fails closed before native work", async () => {
  let called = false;
  const page = {
    setViewportSize: async () => {
      called = true;
    },
  };
  await assert.rejects(
    setScreenshotViewport(page as never, { width: 100, height: 100 }),
    /quarantine/,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(called, false);
});
