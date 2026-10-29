import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { BrowserDiagnostics } from "../../extensions/browser-tools/diagnostics.ts";

test("local failed Save captures exact bodies and reports response gaps", async () => {
  let stream: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url === "/save") {
      req.resume();
      req.on("end", () => {
        res.writeHead(400, {
          "content-type": "text/plain",
          "content-length": "6",
        });
        res.end("failed");
      });
    } else if (req.url === "/gzip") {
      const data = gzipSync("decoded");
      res.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": data.length,
      });
      res.end(data);
    } else if (req.url === "/redirect") {
      res.writeHead(302, { location: "/gzip" });
      res.end();
    } else if (req.url === "/stream") {
      stream = res;
      res.writeHead(200);
      res.write("part");
    } else
      res.end(`<title>fixture</title><button id="save">Save</button><output id="status"></output><script>
      document.querySelector('#save').addEventListener('click', async () => {
        const response = await fetch('/save', {method: 'POST', body: new Uint8Array([0, 255, 42])});
        document.querySelector('#status').textContent = await response.text();
      });
    </script>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert(addr && typeof addr !== "string");
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
  });
  const context = await browser.newContext(),
    page = await context.newPage();
  const d = new BrowserDiagnostics(),
    target = { sessionId: "s", tabId: "t" };
  d.attach(target, page);
  try {
    await page.goto(`http://127.0.0.1:${addr.port}/`);
    await page.locator("#save").click();
    await page.waitForFunction(
      () => document.querySelector("#status")?.textContent === "failed",
    );
    await page.evaluate(async () => {
      await (await fetch("/redirect")).text();
      void fetch("/stream");
    });
    await page.waitForResponse((r) => r.url().endsWith("/stream"));
    for (let i = 0; i < 100; i++) {
      if (
        d.read(target).requests.find((r) => r.url.endsWith("/save"))?.body
          .response !== "pending"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const rows = d.read(target).requests;
    const save = rows.find((r) => r.url.endsWith("/save"))!;
    assert.equal(save.outcome, "http-error");
    assert.equal(save.body.request, "captured");
    assert.equal(save.body.response, "captured");
    assert.equal(
      Buffer.from(
        d.inspectBody(target, save.id, "response").data!,
        "base64",
      ).toString(),
      "failed",
    );
    assert.deepEqual(
      Buffer.from(d.inspectBody(target, save.id, "request").data!, "base64"),
      Buffer.from([0, 255, 42]),
    );
    assert.equal(
      rows.find((r) => r.url.endsWith("/gzip"))!.body.response,
      "unsupported",
    );
    assert.equal(
      rows.find((r) => r.url.endsWith("/redirect"))!.body.response,
      "unsupported",
    );
    assert.equal(
      rows.find((r) => r.url.endsWith("/stream"))!.body.response,
      "pending",
    );
    stream!.end();
  } finally {
    d.shutdown();
    await context.close();
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
