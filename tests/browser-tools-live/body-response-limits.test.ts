import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { BrowserDiagnostics } from "../../extensions/browser-tools/diagnostics.ts";

test(
  "local response limits, cache, concurrency and research opt-in",
  { timeout: 30000 },
  async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 65),
      gzip = gzipSync(big),
      small = Buffer.from("cache-body");
    const server = createServer((req, res) => {
      const path = req.url!;
      if (path === "/big") {
        res.writeHead(200, { "content-length": big.length });
        res.end(big);
      } else if (path === "/gzip") {
        res.writeHead(200, {
          "content-length": gzip.length,
          "content-encoding": "gzip",
        });
        res.end(gzip);
      } else if (path === "/chunked") {
        res.writeHead(200, { "transfer-encoding": "chunked" });
        res.end(big);
      } else if (path === "/cache") {
        res.writeHead(200, {
          "content-length": small.length,
          "cache-control": "public, max-age=3600",
        });
        res.end(small);
      } else if (path.startsWith("/burst")) {
        res.writeHead(200, {
          "content-length": small.length,
          "cache-control": "no-store",
        });
        res.end(small);
      } else res.end("fixture");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    assert(addr && typeof addr !== "string");
    const browser = await chromium.launch({
      channel: "chromium",
      headless: true,
    });
    const context = await browser.newContext(),
      page = await context.newPage();
    const d = new BrowserDiagnostics({
      maxBodyBytes: 1024,
      maxSessionBodyBytes: 2048,
    });
    const t = { sessionId: "s", tabId: "t" };
    d.attach(t, page, false, "research");
    try {
      await page.goto(`http://127.0.0.1:${addr.port}/`);
      await page.evaluate(async () => (await fetch("/cache")).text());
      assert.equal(
        d.read(t).requests.find((r) => r.url.endsWith("/cache"))!.body.response,
        "disabled",
      );
      d.configureBodies(t, true);
      const received = await page.evaluate(async () => {
        const results = [];
        for (const path of ["/big", "/gzip", "/chunked", "/cache"]) {
          const response = await fetch(path);
          results.push((await response.arrayBuffer()).byteLength);
        }
        const burst = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            fetch(`/burst?${i}`).then((r) => r.text()),
          ),
        );
        return { results, burst };
      });
      assert.deepEqual(received.results, [
        big.length,
        big.length,
        big.length,
        small.length,
      ]);
      assert(received.burst.every((x) => x === small.toString()));
      for (let i = 0; i < 100; i++) {
        if (
          !d
            .read(t)
            .requests.some(
              (r) =>
                r.outcome === "pending" ||
                (r.body.response === "pending" && r.url.includes("burst")),
            )
        )
          break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const rows = d.read(t).requests;
      assert.equal(
        rows.find((r) => r.url.endsWith("/big"))!.body.response,
        "oversized",
      );
      assert.equal(
        rows.find((r) => r.url.endsWith("/gzip"))!.body.response,
        "unsupported",
      );
      assert.equal(
        rows.find((r) => r.url.endsWith("/chunked"))!.body.response,
        "unsupported",
      );
      const cached = rows.filter((r) => r.url.endsWith("/cache"))[1];
      assert.equal(cached.body.response, "captured");
      assert.deepEqual(
        Buffer.from(d.inspectBody(t, cached.id, "response").data!, "base64"),
        small,
      );
      const burst = rows.filter((r) => r.url.includes("/burst"));
      assert.equal(burst.length, 12);
      assert(
        burst.every((r) =>
          ["captured", "unsupported"].includes(r.body.response!),
        ),
      );
      assert(
        burst
          .filter((r) => r.body.response === "unsupported")
          .every((r) => r.body.responseReason?.includes("capacity")),
      );
    } finally {
      d.shutdown();
      await context.close();
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
