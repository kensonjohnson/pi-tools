import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachedPage } from "./attachment-page.ts";

test(
  "cancelled navigation is dispatched once and quarantines ownership",
  { timeout: 5000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "attachment-navigation-"));
    let navigations = 0;
    let dispatched!: () => void;
    const sent = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const server = createServer((_req, res) =>
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/devtools/browser/id`,
        }),
      ),
    );
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
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 6) {
          let len = buffer[1] & 127;
          let offset = 2;
          if (len === 126) {
            if (buffer.length < 8) return;
            len = buffer.readUInt16BE(2);
            offset = 4;
          }
          if (len === 127 || buffer.length < offset + 4 + len) return;
          const mask = buffer.subarray(offset, offset + 4);
          const body = Buffer.from(
            buffer.subarray(offset + 4, offset + 4 + len),
          );
          buffer = buffer.subarray(offset + 4 + len);
          for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
          const message = JSON.parse(body.toString());
          if (message.method === "Page.navigate") {
            navigations++;
            dispatched();
            continue;
          }
          const response = Buffer.from(
            JSON.stringify({ id: message.id, result: {} }),
          );
          socket.write(
            Buffer.concat([Buffer.from([0x81, response.length]), response]),
          );
        }
      });
      socket.on("end", () => socket.destroy());
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let page: AttachedPage | undefined;
    try {
      page = await AttachedPage.connect(origin, "chosen", { lockRoot: dir });
      const controller = new AbortController();
      const pending = page.navigate("http://example.test/", {
        signal: controller.signal,
      });
      await sent;
      controller.abort();
      await assert.rejects(pending, /uncertain/i);
      assert.equal(navigations, 1);
      assert.deepEqual(await page.disconnect(), { uncertain: true });
      await assert.rejects(
        AttachedPage.connect(origin, "chosen", {
          lockRoot: dir,
          timeoutMs: 130,
        }),
        /timed out|cancel|unresolved/i,
      );
    } finally {
      await page?.disconnect();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
