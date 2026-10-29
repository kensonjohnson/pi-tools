import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";

// Local bounded experiment, not an assertion of a protocol guarantee.
test(
  "CDP buffer limits and whole response retrieval probe",
  { timeout: 45000 },
  async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 65);
    const compressed = gzipSync(big);
    const server = createServer((req, res) => {
      const path = req.url!.split("?")[0];
      if (path === "/") return res.end("ok");
      if (path === "/redirect") {
        res.writeHead(302, { Location: "/small", "Content-Length": "0" });
        return res.end();
      }
      if (path === "/gzip") {
        res.writeHead(200, {
          "Content-Encoding": "gzip",
          "Content-Length": compressed.length,
          "Cache-Control": "no-store",
        });
        return res.end(compressed);
      }
      if (path === "/chunked") {
        res.writeHead(200, { "Cache-Control": "no-store" });
        for (let i = 0; i < big.length; i += 16384)
          res.write(big.subarray(i, i + 16384));
        return res.end();
      }
      if (path === "/big" || path === "/cachebig") {
        res.writeHead(200, {
          "Content-Length": big.length,
          "Cache-Control":
            path === "/cachebig" ? "public, max-age=3600" : "no-store",
        });
        return res.end(big);
      }
      const n =
        path === "/boundary"
          ? Number(new URL(req.url!, "http://localhost").searchParams.get("n"))
          : 16384;
      res.writeHead(200, {
        "Content-Length": n,
        "Cache-Control":
          path === "/cache" ? "public, max-age=3600" : "no-store",
      });
      res.end(Buffer.alloc(n, 66));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    assert(addr && typeof addr !== "string");
    const browser = await chromium.launch({
      headless: true,
      channel: "chromium",
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    try {
      await page.goto(`http://127.0.0.1:${addr.port}/`);
      await page.evaluate(
        async () => (await (await fetch("/cachebig")).arrayBuffer()).byteLength,
      );
      await cdp.send("Network.enable", {
        maxResourceBufferSize: 65536,
        maxTotalBufferSize: 65536,
      });
      const responses = new Map<string, any>();
      const redirects: any[] = [];
      cdp.on("Network.requestWillBeSent", (e) => {
        if (e.redirectResponse)
          redirects.push({
            id: e.requestId,
            status: e.redirectResponse.status,
            url: e.redirectResponse.url,
          });
      });
      cdp.on("Network.responseReceived", (e) =>
        responses.set(e.requestId, e.response),
      );
      const records: any[] = [];
      for (const path of [
        "/small",
        "/boundary?n=32768",
        "/boundary?n=49152",
        "/boundary?n=65535",
        "/boundary?n=65536",
        "/boundary?n=65537",
        "/big",
        "/chunked",
        "/gzip",
        "/cache",
        "/cache",
        "/cachebig",
        "/redirect",
      ]) {
        const finished = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("loadingFinished timeout " + path)),
            5000,
          );
          const handler = (e: any) => {
            if (
              responses
                .get(e.requestId)
                ?.url.includes(
                  path === "/redirect" ? "/small" : path.split("?")[0],
                )
            ) {
              clearTimeout(timer);
              cdp.off("Network.loadingFinished", handler);
              resolve(e.requestId);
            }
          };
          cdp.on("Network.loadingFinished", handler);
        });
        const pageBytesPromise = page.evaluate(async (p) => {
          const r = await fetch(p);
          return {
            bytes: (await r.arrayBuffer()).byteLength,
            status: r.status,
          };
        }, path);
        const [id, pageResult] = await Promise.all([
          finished,
          pageBytesPromise,
        ]);
        let body: any;
        try {
          const result = await cdp.send("Network.getResponseBody", {
            requestId: id,
          });
          body = {
            bytes: result.base64Encoded
              ? Buffer.from(result.body, "base64").length
              : Buffer.byteLength(result.body),
            base64: result.base64Encoded,
          };
        } catch (e) {
          body = { error: String(e) };
        }
        const r = responses.get(id);
        records.push({
          path,
          page: pageResult,
          wireHeader:
            r.headers["Content-Length"] ?? r.headers["content-length"] ?? null,
          fromDiskCache: r.fromDiskCache,
          body,
        });
      }
      console.log(
        "BOUNDED_PROBE",
        JSON.stringify({
          chromium: browser.version(),
          limits: { maxResourceBufferSize: 65536, maxTotalBufferSize: 65536 },
          gzipWireBytes: compressed.length,
          redirects,
          records,
        }),
      );
      for (const record of records) {
        const expected = record.path.startsWith("/boundary")
          ? Number(
              new URL(record.path, "http://localhost").searchParams.get("n"),
            )
          : ["/big", "/chunked", "/gzip", "/cachebig"].includes(record.path)
            ? big.length
            : 16384;
        assert.deepEqual(record.page, { bytes: expected, status: 200 });
      }
    } finally {
      await cdp.detach();
      await context.close();
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
