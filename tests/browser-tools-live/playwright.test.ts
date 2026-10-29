import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";

// This checks the pinned package and local binary, not the staged session runtime.
test("pinned Chromium opens independent pages and navigates a local fixture", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<title>${req.url === "/one" ? "one" : "two"}</title>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
    });
    const context = await browser.newContext();
    const one = await context.newPage();
    const two = await context.newPage();
    await one.goto(`http://127.0.0.1:${address.port}/one`);
    await two.goto(`http://127.0.0.1:${address.port}/two`);
    assert.equal(await one.title(), "one");
    assert.equal(await two.title(), "two");
    await context.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
