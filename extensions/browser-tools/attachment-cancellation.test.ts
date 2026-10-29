import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connectAttachment } from "./attachment-transport.ts";

test(
  "abort during a stalled WebSocket upgrade closes the local upstream",
  { timeout: 5000 },
  async () => {
    let upgraded!: () => void;
    const upgrade = new Promise<void>((resolve) => {
      upgraded = resolve;
    });
    let closed!: () => void;
    const close = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const server = createServer((_req, res) => {
      const port = (server.address() as { port: number }).port;
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/id`,
        }),
      );
    });
    server.on("upgrade", (_req, socket) => {
      socket.on("end", () => {
        socket.destroy();
        closed();
      });
      socket.on("close", closed);
      socket.resume();
      upgraded();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const controller = new AbortController();
      const pending = connectAttachment(
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        { signal: controller.signal },
      );
      await upgrade;
      controller.abort();
      await assert.rejects(pending, /abort/i);
      await close;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
