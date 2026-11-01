import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { DownloadManager } from "./downloads.ts";
import { ManagedSessions } from "./sessions.ts";

const setup = async () => {
  const page = new EventEmitter() as any,
    browser = new EventEmitter() as any;
  let closed = false;
  page.isClosed = () => closed;
  page.url = () => "about:blank";
  page.close = async () => {
    closed = true;
    page.emit("close");
  };
  browser.newContext = async () => ({ newPage: async () => page });
  browser.close = async () => {
    await page.close();
    browser.emit("disconnected");
  };
  const downloads = new DownloadManager({
    sink: {
      putBinary: async () => {
        throw new Error("quota exceeded");
      },
    },
  });
  const sessions = new ManagedSessions({
    launch: async () => browser,
    downloads,
  });
  const target = await sessions.start({ artifactOwner: "owner" });
  page.emit("download", {
    url: () => "https://example.test/a",
    suggestedFilename: () => "a",
    failure: async () => null,
    createReadStream: async () => Readable.from([Buffer.from("abc")]),
    cancel: async () => {},
    delete: async () => {},
  });
  const id = downloads.list(target.sessionId)[0].id;
  await downloads.wait(target.sessionId, id);
  return { sessions, downloads, target, id, closed: () => closed };
};
test("explicit stop blocks unexported bytes until owner opts into loss", async () => {
  const { sessions, downloads, target, id, closed } = await setup();
  await assert.rejects(
    sessions.stop(target.sessionId, 5000, undefined, "owner"),
    /abandonDownloads=true/,
  );
  assert.equal(closed(), false);
  await assert.rejects(
    sessions.stop(target.sessionId, 5000, undefined, "other", true),
    /Session unavailable/,
  );
  await sessions.stop(target.sessionId, 5000, undefined, "owner", true);
  assert.equal(closed(), true);
  assert.equal(
    downloads.inspect(target.sessionId, id).nativeRecovery,
    "unknown_after_close",
  );
  await sessions.shutdown();
});
test("shutdown reports owner-scoped native loss risk without blocking", async () => {
  const { sessions, target, id } = await setup();
  const result = await sessions.shutdown(5000, "owner");
  assert.equal(result.complete, false);
  assert.equal(result.downloadRisk?.[0].id, id);
  assert.equal(result.downloadRisk?.[0].sessionId, target.sessionId);
});
test("stop blocks in-flight downloads before they can fail during closure", async () => {
  const { sessions, downloads, target } = await setup();
  const page = (sessions as any).sessions
    .get(target.sessionId)
    .pages.values()
    .next().value;
  page.emit("download", {
    url: () => "https://example.test/b",
    suggestedFilename: () => "b",
    failure: () => new Promise(() => {}),
    createReadStream: async () => null,
    cancel: async () => {},
    delete: async () => {},
  });
  assert.ok(
    downloads
      .closeRisks("owner", target.sessionId)
      .some((item) => item.state === "pending"),
  );
  await assert.rejects(
    sessions.stop(target.sessionId, 5000, undefined, "owner"),
    /active or have unexported/,
  );
  await sessions.stop(target.sessionId, 5000, undefined, "owner", true);
});
