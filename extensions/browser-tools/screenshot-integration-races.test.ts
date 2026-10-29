import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ManagedSessions } from "./sessions.ts";
import { resolveScreenshotLimits } from "./settings.ts";

class Page extends EventEmitter {
  closed = false;
  entered!: () => void;
  started = new Promise<void>((resolve) => {
    this.entered = resolve;
  });
  isClosed() {
    return this.closed;
  }
  url() {
    return "about:blank";
  }
  context() {
    return {
      newCDPSession: async () => ({
        send: async () => ({
          cssLayoutViewport: { clientWidth: 10, clientHeight: 10 },
        }),
        detach: async () => {},
      }),
    };
  }
  screenshot() {
    this.entered();
    return new Promise<Buffer>(() => {});
  }
  setViewportSize() {
    this.entered();
    return new Promise<void>(() => {});
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
}
class Browser extends EventEmitter {
  page = new Page();
  async newContext() {
    return { newPage: async () => this.page };
  }
  async close() {
    await this.page.close();
    this.emit("disconnected");
  }
}
const limits = {
  maxDimension: 1000,
  maxPixels: 1000000,
  maxBytes: 1000000,
  timeoutMs: 100,
};

test("screenshot limits resolve configured bounds and reject invalid settings", () => {
  const limits = resolveScreenshotLimits({
    screenshotMaxPixels: 20000,
    screenshotTimeoutMs: 100,
    screenshotMaxBytes: 999999999,
  });
  assert.equal(limits.maxPixels, 20000);
  assert.equal(limits.timeoutMs, 100);
  assert.equal(limits.maxBytes, 12000000);
});

test("aborted screenshot synchronously quarantines its owned session", async () => {
  const browser = new Browser();
  const sessions = new ManagedSessions({
    launch: async () => browser as never,
  });
  const target = await sessions.start({ artifactOwner: "owner" });
  const abort = new AbortController();
  const pending = sessions.screenshot(
    target,
    "owner",
    {} as never,
    { scope: "viewport", limits: { ...limits, timeoutMs: 1000 } },
    abort.signal,
  );
  await browser.page.started;
  abort.abort();
  await assert.rejects(pending, /Native work may still be in flight/);
  await assert.rejects(
    sessions.viewport(target, "owner", { width: 10, height: 10 }, limits),
    /Session unavailable/,
  );
  await sessions.shutdown(200);
});

test("timed out viewport invalidates its session before lock release", async () => {
  const browser = new Browser();
  const sessions = new ManagedSessions({
    launch: async () => browser as never,
  });
  const target = await sessions.start({ artifactOwner: "owner" });
  await assert.rejects(
    sessions.viewport(target, "owner", { width: 10, height: 10 }, limits),
    /timed out.*quarantine/i,
  );
  await assert.rejects(
    sessions.viewport(target, "owner", { width: 10, height: 10 }, limits),
    /Session unavailable/,
  );
  await sessions.shutdown(200);
});
