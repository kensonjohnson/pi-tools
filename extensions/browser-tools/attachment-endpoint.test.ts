import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  discoverAttachmentEndpoint,
  validateAttachmentEndpoint,
} from "./attachment-endpoint.ts";

test("attachment endpoints accept only explicit literal loopback authorities", () => {
  for (const input of [
    "http://localhost:9222",
    "http://127.1:9222",
    "http://2130706433:9222",
    "http://0x7f000001:9222",
    "http://127.0.0.2:9222",
    "http://user@127.0.0.1:9222",
    "http://127.0.0.1:9222#x",
    "http://127.0.0.1:9222\\@evil",
    "http://[::ffff:127.0.0.1]:9222",
    "https://127.0.0.1:9222",
    "http://127.0.0.1",
  ]) {
    assert.throws(
      () => validateAttachmentEndpoint(input, "http:"),
      undefined,
      input,
    );
  }
  assert.equal(
    validateAttachmentEndpoint("ws://[::1]:1234/devtools/browser/id", "ws:")
      .hostname,
    "[::1]",
  );
});

test("discovery rejects redirects, foreign WebSockets, oversize and aborts", async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, "/json/version");
    if (mode === "redirect") {
      res.writeHead(302, { location: "http://example.com" });
      res.end();
    } else if (mode === "wait") {
      /* wait for caller to abort */
    } else if (mode === "large") res.end("x".repeat(65537));
    else
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl:
            mode === "foreign"
              ? "ws://127.0.0.1:9/devtools/browser/x"
              : `ws://127.0.0.1:${port}/devtools/browser/x`,
        }),
      );
  });
  let mode = "ok";
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    assert.equal(
      await discoverAttachmentEndpoint(endpoint),
      `ws://127.0.0.1:${port}/devtools/browser/x`,
    );
    for (mode of ["redirect", "foreign", "large"])
      await assert.rejects(discoverAttachmentEndpoint(endpoint));
    mode = "wait";
    await assert.rejects(
      discoverAttachmentEndpoint(endpoint, { timeoutMs: 20 }),
      /timed out/,
    );
    const controller = new AbortController();
    const pending = discoverAttachmentEndpoint(endpoint, {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, /aborted/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
