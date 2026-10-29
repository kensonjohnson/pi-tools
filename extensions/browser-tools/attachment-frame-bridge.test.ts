import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createAttachmentBridge } from "./attachment-transport.ts";

test(
  "bridge closes on an oversized upstream CDP frame before payload arrives",
  { timeout: 5000 },
  async () => {
    const server = createServer();
    server.on("upgrade", (req, socket) => {
      const accept = createHash("sha1")
        .update(
          String(req.headers["sec-websocket-key"]) +
            "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
        )
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(32 * 1024 * 1024 + 1), 2);
      socket.write(header);
      socket.on("error", () => {});
      socket.on("end", () => socket.destroy());
      socket.resume();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const bridge = await createAttachmentBridge(
      `ws://127.0.0.1:${(server.address() as { port: number }).port}/devtools/browser/id`,
    );
    try {
      const ws = new WebSocket(bridge.url);
      let messages = 0;
      ws.addEventListener("message", () => messages++);
      await new Promise<void>((resolve) => {
        ws.addEventListener("error", () => resolve(), { once: true });
        ws.addEventListener("close", () => resolve(), { once: true });
      });
      assert.equal(messages, 0);
    } finally {
      bridge.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
