import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttachedPage } from "./attachment-page.ts";

for (const mode of ["inspect", "title"] as const)
  test(
    `${mode} fails closed if the selected document navigates during observation`,
    { timeout: 5000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "attachment-inspection-nav-"));
      const methods: string[] = [];
      const server = createServer((_req, res) =>
        res.end(
          JSON.stringify({
            webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as any).port}/devtools/browser/id`,
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
        const send = (value: unknown) => {
          const bytes = Buffer.from(JSON.stringify(value));
          const header =
            bytes.length < 126
              ? Buffer.from([0x81, bytes.length])
              : Buffer.from([0x81, 126, bytes.length >> 8, bytes.length & 255]);
          socket.write(Buffer.concat([header, bytes]));
        };
        let buffer = Buffer.alloc(0);
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= 6) {
            let length = buffer[1] & 127,
              offset = 2;
            if (length === 126) {
              if (buffer.length < 8) return;
              length = buffer.readUInt16BE(2);
              offset = 4;
            }
            if (length === 127) {
              if (buffer.length < 14) return;
              length = Number(buffer.readBigUInt64BE(2));
              offset = 10;
            }
            if (buffer.length < offset + 4 + length) return;
            const mask = buffer.subarray(offset, offset + 4),
              data = Buffer.from(
                buffer.subarray(offset + 4, offset + 4 + length),
              );
            buffer = buffer.subarray(offset + 4 + length);
            for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
            let message: any;
            try {
              message = JSON.parse(data.toString());
            } catch {
              continue;
            }
            methods.push(message.method);
            if (message.method === "Page.getFrameTree")
              send({
                id: message.id,
                result: {
                  frameTree: {
                    frame: {
                      id: "frame",
                      loaderId: "loader",
                      url: "https://example.test/",
                    },
                  },
                },
              });
            else if (message.method === "Page.createIsolatedWorld") {
              assert.equal(message.params.frameId, "frame");
              send({ id: message.id, result: { executionContextId: 55 } });
            } else if (message.method === "Runtime.evaluate") {
              assert.equal(message.params.contextId, 55);
              if (mode === "title") {
                send({
                  method: "Page.frameNavigated",
                  params: { frame: { id: "frame", loaderId: "new" } },
                });
                send({
                  id: message.id,
                  result: {
                    result: { value: { title: "old", truncated: false } },
                  },
                });
              } else {
                send({
                  id: message.id,
                  result: { result: { objectId: "object" } },
                });
              }
            } else if (message.method === "Runtime.callFunctionOn") {
              send({
                method: "Page.frameNavigated",
                params: { frame: { id: "frame", loaderId: "new" } },
              });
              send({
                id: message.id,
                result: {
                  result: {
                    value: {
                      text: "a",
                      done: false,
                      reason: null,
                      title: "",
                      titleTruncated: false,
                      nodesVisited: 1,
                      charsReturned: 1,
                    },
                  },
                },
              });
            } else send({ id: message.id, result: {} });
          }
        });
        socket.on("end", () => socket.destroy());
        socket.on("error", () => {});
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      let page: AttachedPage | undefined;
      try {
        page = await AttachedPage.connect(
          `http://127.0.0.1:${(server.address() as any).port}`,
          "target",
          { lockRoot: root },
        );
        await assert.rejects(
          mode === "title" ? page.title() : page.inspect(),
          /Document changed.*uncertain/,
        );
        assert.equal(
          methods.filter((method) => method === "Runtime.callFunctionOn")
            .length,
          mode === "inspect" ? 1 : 0,
        );
        assert.ok(!methods.includes("Page.navigate"));
        assert.equal(
          methods.filter((method) => method === "Runtime.releaseObject").length,
          mode === "inspect" ? 1 : 0,
        );
        assert.deepEqual(await page.disconnect(), { uncertain: true });
        await assert.rejects(
          AttachedPage.connect(
            `http://127.0.0.1:${(server.address() as any).port}`,
            "target",
            { lockRoot: root, timeoutMs: 130 },
          ),
          /timed out|cancel|unresolved/i,
        );
      } finally {
        await page?.disconnect();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
