import { createServer, request, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { chromium, type Browser } from "playwright";
import { AttachmentFrameLimit } from "./attachment-frames.ts";
import {
  discoverAttachmentEndpoint,
  validateAttachmentEndpoint,
} from "./attachment-endpoint.ts";

/** A single-use loopback bridge. The upstream handshake never follows redirects. */
export async function createAttachmentBridge(
  endpoint: string,
): Promise<{ url: string; close(): void }> {
  const upstream = validateAttachmentEndpoint(endpoint, "ws:");
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  let used = false;
  let closed = false;
  const server: Server = createServer({ maxHeaderSize: 8192 }, (_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.maxConnections = 2;
  server.on("connection", (socket) => {
    // Only the first local connection may reach the single-use secret endpoint.
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  server.on("upgrade", (incoming, client, head) => {
    if (
      used ||
      closed ||
      incoming.url !== `/${token}` ||
      incoming.method !== "GET" ||
      incoming.headers.upgrade?.toLowerCase() !== "websocket" ||
      !incoming.headers["sec-websocket-key"]
    ) {
      client.destroy();
      return;
    }
    used = true;
    const req = request({
      hostname: upstream.hostname.replace(/^\[|\]$/g, ""),
      port: upstream.port,
      path: upstream.pathname + upstream.search,
      method: "GET",
      agent: false,
      headers: {
        host: upstream.host,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": incoming.headers["sec-websocket-key"],
        "sec-websocket-version": "13",
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      client.destroy();
    }, 5000);
    client.once("close", () => {
      clearTimeout(timer);
      req.destroy();
    });
    req.on("error", () => {
      clearTimeout(timer);
      client.destroy();
    });
    req.on("response", (response) => {
      clearTimeout(timer);
      response.destroy();
      client.destroy();
    });
    req.on("upgrade", (response, remote, remoteHead) => {
      clearTimeout(timer);
      sockets.add(remote);
      remote.on("close", () => sockets.delete(remote));
      remote.on("error", () => client.destroy());
      client.on("error", () => remote.destroy());
      if (closed || response.statusCode !== 101) {
        remote.destroy();
        client.destroy();
        return;
      }
      // Forward only handshake fields; Node validates header syntax. No redirect is followed.
      let handshake = "HTTP/1.1 101 Switching Protocols\r\n";
      for (let i = 0; i < response.rawHeaders.length; i += 2)
        handshake += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`;
      client.write(handshake + "\r\n");
      // Chromium does not negotiate WebSocket compression through this bridge.
      // Limit each uncompressed CDP message in both directions while retaining
      // stream backpressure. This also limits large screenshots and artifacts.
      const toClient = new AttachmentFrameLimit(false, 32 * 1024 * 1024);
      const toRemote = new AttachmentFrameLimit(true, 32 * 1024 * 1024);
      const fail = () => {
        client.destroy();
        remote.destroy();
      };
      toClient.on("error", fail);
      toRemote.on("error", fail);
      toClient.pipe(client);
      toRemote.pipe(remote);
      if (remoteHead.length) toClient.write(remoteHead);
      if (head.length) toRemote.write(head);
      remote.pipe(toClient);
      client.pipe(toRemote);
      client.once("close", () => {
        remote.destroy();
        toClient.destroy();
        toRemote.destroy();
      });
      remote.once("close", () => {
        client.destroy();
        toClient.destroy();
        toRemote.destroy();
      });
    });
    req.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}/${token}`,
    close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

/** Connect only after local discovery; abort closes the transport even if Playwright resolves late. */
export async function connectAttachment(
  origin: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ browser: Browser; disconnect(): void }> {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new Error("Invalid attachment timeout");
  if (options.signal?.aborted) throw new Error("Attachment aborted");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let bridge: Awaited<ReturnType<typeof createAttachmentBridge>> | undefined;
  try {
    const endpoint = await discoverAttachmentEndpoint(origin, {
      signal: controller.signal,
      timeoutMs,
    });
    if (controller.signal.aborted)
      throw new Error("Attachment aborted or timed out");
    bridge = await createAttachmentBridge(endpoint);
    if (controller.signal.aborted)
      throw new Error("Attachment aborted or timed out");
    const pending = chromium.connectOverCDP(bridge.url, { timeout: timeoutMs });
    const browser = await new Promise<Browser>((resolve, reject) => {
      const cancel = () => {
        bridge!.close();
        reject(new Error("Attachment aborted or timed out"));
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      if (controller.signal.aborted) cancel();
      pending.then(
        (value) => {
          controller.signal.removeEventListener("abort", cancel);
          if (controller.signal.aborted) {
            bridge!.close();
          } else resolve(value);
        },
        (error) => {
          controller.signal.removeEventListener("abort", cancel);
          reject(error);
        },
      );
    });
    const ownedBridge = bridge;
    browser.once("disconnected", () => ownedBridge.close());
    if (!browser.isConnected())
      throw new Error("Attachment disconnected during startup");
    return { browser, disconnect: () => ownedBridge.close() };
  } catch (error) {
    bridge?.close();
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
