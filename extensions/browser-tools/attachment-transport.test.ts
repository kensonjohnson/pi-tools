import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createAttachmentBridge,
  connectAttachment,
} from "./attachment-transport.ts";

for (const host of ["127.0.0.1", "::1"])
  test(`bridge rejects upstream WebSocket redirect on ${host}`, async (t) => {
    let reached = 0;
    const trap = createServer((_req, res) => {
      reached++;
      res.end();
    });
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: "http://example.com" });
      res.end();
    });
    server.on("upgrade", (_req, socket) => {
      socket.end(
        `HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:${(trap.address() as { port: number }).port}/escape\r\nContent-Length: 0\r\n\r\n`,
      );
    });
    try {
      await new Promise<void>((resolve, reject) =>
        trap.once("error", reject).listen(0, "127.0.0.1", resolve),
      );
      try {
        await new Promise<void>((resolve, reject) =>
          server.once("error", reject).listen(0, host, resolve),
        );
      } catch (err: any) {
        if (
          host === "::1" &&
          ["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(err.code)
        ) {
          t.skip("IPv6 loopback unavailable");
          return;
        }
        throw err;
      }
      const port = (server.address() as { port: number }).port;
      const origin = `http://${host === "::1" ? "[::1]" : host}:${port}`;
      await assert.rejects(connectAttachment(origin), /redirect|non-200/);
      const bridge = await createAttachmentBridge(
        `ws://${host === "::1" ? "[::1]" : host}:${port}/devtools/browser/test`,
      );
      try {
        const ws = new WebSocket(bridge.url);
        await new Promise<void>((resolve) => {
          ws.addEventListener("error", () => resolve(), { once: true });
          ws.addEventListener("close", () => resolve(), { once: true });
        });
        assert.equal(reached, 0);
      } finally {
        bridge.close();
      }
    } finally {
      server.closeAllConnections();
      trap.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => server.close(() => r())),
        new Promise<void>((r) => trap.close(() => r())),
      ]);
    }
  });

test("aborting stalled discovery closes the request", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const controller = new AbortController();
    const pending = connectAttachment(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, /abort/i);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
