import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ManagedSessions } from "./sessions.ts";

test("attachment discovery rejects redirects, malformed endpoints and cancellation without late registration", async () => {
  let delay = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const requestEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = createServer(async (request, response) => {
    if (request.url === "/json/version") {
      if (delay) {
        entered();
        await gate;
      }
      response.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as any).port}/devtools/browser/id`,
        }),
      );
    } else {
      response.writeHead(302, { location: "http://example.invalid/escape" });
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const sessions = new ManagedSessions({
    launch: async () => {
      throw new Error("unexpected");
    },
  });
  try {
    await assert.rejects(
      sessions.attachExternal("http://localhost:9222", "owner"),
      /literal loopback/,
    );
    await assert.rejects(
      sessions.attachExternal(`${origin}/path`, "owner"),
      /origin/,
    );
    const attached = await sessions.attachExternal(origin, "owner");
    await assert.rejects(
      sessions.attachmentTargets(attached.attachmentId, "owner"),
      /redirect/,
    );
    assert.deepEqual(sessions.listAttachments("owner"), []);
    delay = true;
    const abort = new AbortController();
    const pending = sessions.attachExternal(origin, "owner", abort.signal);
    await requestEntered;
    abort.abort();
    await assert.rejects(pending, /abort|cancel/i);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sessions.listAttachments("owner"), []);
  } finally {
    release();
    await sessions.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
