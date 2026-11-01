import { test } from "node:test";
import assert from "node:assert/strict";
import { ManagedSessions } from "./sessions.ts";

test("attachment operation and selection deadlines accept the Node timer boundary", async () => {
  const sessions = new ManagedSessions({
    launch: async () => {
      throw new Error("unused");
    },
  });
  const seen: number[] = [];
  const page = {
    title: async (options: { timeoutMs: number }) => {
      seen.push(options.timeoutMs);
      return { title: "fixture", truncated: false };
    },
    disconnect: async () => ({ uncertain: false }),
  };
  const attachments = (sessions as any).attachments;
  attachments.set("selected", {
    id: "selected",
    owner: "owner",
    origin: "http://127.0.0.1:1",
    targetId: "target",
    page,
    stop: new AbortController(),
    busy: false,
    discovered: new Set(),
  });
  attachments.set("unselected", {
    id: "unselected",
    owner: "owner",
    origin: "http://127.0.0.1:1",
    stop: new AbortController(),
    busy: false,
    discovered: new Set(),
  });
  try {
    for (const timeoutMs of [30001, 2147483647]) {
      const value = await sessions.attachmentWork(
        "selected",
        "owner",
        "target",
        "title",
        { timeoutMs },
      );
      assert.equal(value.title, "fixture");
      await assert.rejects(
        sessions.selectAttachment(
          "unselected",
          "owner",
          "unknown",
          undefined,
          timeoutMs,
        ),
        /explicitly discovered/,
      );
    }
    assert.deepEqual(seen, [30001, 2147483647]);
    await assert.rejects(
      sessions.attachmentWork("selected", "owner", "target", "title", {
        timeoutMs: 2147483648,
      }),
      /Invalid attachment operation timeout/,
    );
    await assert.rejects(
      sessions.selectAttachment(
        "unselected",
        "owner",
        "unknown",
        undefined,
        2147483648,
      ),
      /Invalid attachment selection timeout/,
    );
  } finally {
    await sessions.shutdown();
  }
});
