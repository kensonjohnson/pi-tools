import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { DownloadManager, type NativeDownload } from "./downloads.ts";

function native(text: string, gate?: Promise<string | null>) {
  const calls = {
    url: 0,
    name: 0,
    failure: 0,
    stream: 0,
    cancel: 0,
    delete: 0,
  };
  const download: NativeDownload = {
    url: () => {
      calls.url++;
      return "https://example.test/private";
    },
    suggestedFilename: () => {
      calls.name++;
      return "private.txt";
    },
    failure: async () => {
      calls.failure++;
      return gate ? await gate : null;
    },
    createReadStream: async () => {
      calls.stream++;
      return Readable.from([Buffer.from(text)]);
    },
    cancel: async () => {
      calls.cancel++;
    },
    delete: async () => {
      calls.delete++;
    },
  };
  return { download, calls };
}
test("handoff ignores human downloads without reading, cancelling or deleting them; prior work may finish", async () => {
  const files: string[] = [];
  const manager = new DownloadManager({
    sink: {
      putBinary: async (_owner, stream) => {
        let text = "";
        for await (const chunk of stream) text += Buffer.from(chunk).toString();
        files.push(text);
        return {
          id: `id-${files.length}`,
          path: "/private",
          bytes: Buffer.byteLength(text),
          expiresAt: 1,
        };
      },
    },
  });
  const page = new EventEmitter();
  const target = { sessionId: "session", tabId: "tab" };
  manager.attach(target, page, "owner");
  assert.throws(
    () => manager.suspendSession(target.sessionId, "foreign"),
    /cannot be suspended/,
  );
  const otherPage = new EventEmitter();
  const otherTarget = { sessionId: "other-session", tabId: "other-tab" };
  manager.attach(otherTarget, otherPage, "other-owner");
  let release!: (value: string | null) => void;
  const prior = native(
    "prior",
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  page.emit("download", prior.download);
  const priorId = manager.list(target.sessionId)[0].id;
  const suspended = manager.suspendSession(target.sessionId, "owner");
  assert.equal(suspended.inFlightBefore, 1);
  assert.throws(
    () => manager.resumeSession(target.sessionId, "foreign"),
    /unavailable/,
  );
  const human = native("human secret");
  page.emit("download", human.download);
  assert.deepEqual(human.calls, {
    url: 0,
    name: 0,
    failure: 0,
    stream: 0,
    cancel: 0,
    delete: 0,
  });
  release(null);
  assert.equal(
    (await manager.wait(target.sessionId, priorId)).state,
    "complete",
  );
  assert.deepEqual(files, ["prior"]);
  const other = native("other-session");
  otherPage.emit("download", other.download);
  const otherId = manager.list(otherTarget.sessionId)[0].id;
  assert.equal(
    (await manager.wait(otherTarget.sessionId, otherId)).state,
    "complete",
  );
  assert.deepEqual(files, ["prior", "other-session"]);
  assert.deepEqual(manager.resumeSession(target.sessionId, "owner"), {
    ignored: 1,
    inFlightBefore: 1,
  });
  const after = native("after");
  page.emit("download", after.download);
  const afterId = manager
    .list(target.sessionId)
    .find((entry) => entry.id !== priorId)!.id;
  assert.equal(
    (await manager.wait(target.sessionId, afterId)).state,
    "complete",
  );
  assert.deepEqual(files, ["prior", "other-session", "after"]);
  await manager.shutdown();
  assert.equal(human.calls.cancel, 0);
  assert.equal(human.calls.delete, 0);
});

test("queued listener from a detached handoff tab never cancels or deletes the human download", async () => {
  const manager = new DownloadManager({
    sink: {
      putBinary: async () => {
        throw new Error("unexpected");
      },
    },
  });
  const page = new EventEmitter(),
    target = { sessionId: "session", tabId: "tab" };
  manager.attach(target, page, "owner");
  const listener = page.listeners("download")[0] as (
    download: NativeDownload,
  ) => void;
  manager.suspendSession(target.sessionId, "owner");
  manager.detach(target);
  const human = native("human secret");
  listener(human.download);
  manager.resumeSession(target.sessionId, "owner");
  listener(human.download);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(human.calls, {
    url: 0,
    name: 0,
    failure: 0,
    stream: 0,
    cancel: 0,
    delete: 0,
  });
  await manager.shutdown();
});
