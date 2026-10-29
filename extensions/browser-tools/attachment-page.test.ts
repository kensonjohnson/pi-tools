import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttachedPage } from "./attachment-page.ts";

test(
  "page CDP operation timeout disconnects and quarantines its target",
  { timeout: 5000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "attachment-page-unit-"));
    let requested = "";
    const server = createServer((_req, res) =>
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/devtools/browser/id`,
        }),
      ),
    );
    server.on("upgrade", (req, socket) => {
      requested = req.url ?? "";
      const accept = createHash("sha1")
        .update(
          String(req.headers["sec-websocket-key"]) +
            "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
        )
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on("end", () => socket.destroy());
      socket.on("error", () => {});
      socket.resume();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let page: AttachedPage | undefined;
    try {
      await assert.rejects(
        AttachedPage.connect(origin, "../../escape", { lockRoot: dir }),
        /target/i,
      );
      page = await AttachedPage.connect(origin, "chosen", { lockRoot: dir });
      assert.equal(requested, "/devtools/page/chosen");
      await assert.rejects(page.title({ timeoutMs: 30 }), /uncertain/i);
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
