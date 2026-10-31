import { test } from "node:test";
import assert from "node:assert/strict";
import { constants as bufferConstants } from "node:buffer";
import {
  captureScreenshot,
  setScreenshotViewport,
  screenshotImageFitsString,
} from "./screenshots.ts";

const limits = {
  maxDimension: 1000,
  maxPixels: 1000000,
  maxBytes: 1000000,
  timeoutMs: 50,
};
test("user budgets exceed former limits and geometry arithmetic stays exact", async () => {
  let viewport: unknown;
  const page = {
    setViewportSize: async (size: unknown) => {
      viewport = size;
    },
  };
  const generous = {
    maxDimension: Number.MAX_SAFE_INTEGER,
    maxPixels: Number.MAX_SAFE_INTEGER,
    maxBytes: Number.MAX_SAFE_INTEGER,
    timeoutMs: 1000,
  };
  await setScreenshotViewport(
    page as never,
    { width: 40000, height: 1000 },
    generous,
    undefined,
    () => {},
  );
  assert.deepEqual(viewport, { width: 40000, height: 1000 });
  const width = 94906266;
  assert.ok(BigInt(width) * BigInt(width) > BigInt(Number.MAX_SAFE_INTEGER));
  await assert.rejects(
    setScreenshotViewport(
      page as never,
      { width, height: width },
      generous,
      undefined,
      () => {},
    ),
    /capture limit exceeded/,
  );
  await assert.rejects(
    setScreenshotViewport(
      page as never,
      { width: Number.MAX_SAFE_INTEGER + 1, height: 1 },
      generous,
      undefined,
      () => {},
    ),
    /Invalid viewport/,
  );
});

test("screenshot deadlines accept platform maximum and preserve cancellation", async () => {
  const page = { setViewportSize: async () => {} };
  for (const timeoutMs of [30001, 2147483647]) {
    const result = await setScreenshotViewport(
      page as never,
      { width: 10, height: 10 },
      { ...limits, timeoutMs },
      undefined,
      () => {},
    );
    assert.equal(result.width, 10);
  }
  await assert.rejects(
    setScreenshotViewport(
      page as never,
      { width: 10, height: 10 },
      { ...limits, timeoutMs: 2147483648 },
      undefined,
      () => {},
    ),
    /Invalid screenshot limits/,
  );
});

test("base64 platform string bounds are checked before allocating image content", () => {
  const maxBytes = Math.floor(bufferConstants.MAX_STRING_LENGTH / 4) * 3;
  assert.equal(screenshotImageFitsString(maxBytes), true);
  assert.equal(screenshotImageFitsString(maxBytes + 1), false);
  assert.equal(screenshotImageFitsString(Number.MAX_SAFE_INTEGER + 1), false);
});

test("capture accepts a PNG larger than the old twelve-megabyte limit", async () => {
  const png = Buffer.alloc(12_000_001);
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
  let saved = 0;
  const artifacts = {
    putBinary: async (_owner: string, source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) saved += chunk.length;
      return { id: "id", bytes: saved, expiresAt: 1 };
    },
  };
  const result = await captureScreenshot({
    page: page as never,
    owner: "owner",
    artifacts: artifacts as never,
    scope: "viewport",
    limits: { ...limits, maxBytes: png.length, timeoutMs: 1000 },
    quarantine: () => {},
  });
  assert.equal(saved, png.length);
  assert.equal(result.content[1].type, "image");
});

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
