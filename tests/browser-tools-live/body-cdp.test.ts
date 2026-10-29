import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { chromium } from "playwright";

test("CDP streaming returns pre-buffered data without an admission limit", async () => {
  let response: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url === "/stream") {
      response = res;
      res.writeHead(200);
      res.write(Buffer.alloc(256 * 1024, 65));
    } else res.end("ok");
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
    page = await context.newPage(),
    cdp = await context.newCDPSession(page);
  try {
    await page.goto(`http://127.0.0.1:${addr.port}/`);
    await cdp.send("Network.enable");
    let id = "";
    let received = 0;
    cdp.on("Network.responseReceived", (e) => {
      if (e.response.url.endsWith("/stream")) id = e.requestId;
    });
    cdp.on("Network.dataReceived", (e) => {
      if (e.requestId === id) received += e.dataLength;
    });
    await page.evaluate(() => {
      void fetch("/stream");
    });
    for (let i = 0; i < 100 && received < 256 * 1024; i++)
      await page.waitForTimeout(20);
    assert.equal(received, 256 * 1024);
    assert(id);
    const streamed = await cdp.send("Network.streamResourceContent", {
      requestId: id,
    });
    assert.equal(
      Buffer.from(streamed.bufferedData, "base64").length,
      256 * 1024,
    );
    response!.end();
  } finally {
    response?.end();
    await cdp.detach();
    await context.close();
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
