import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import { extractPage } from "../../extensions/browser-tools/extraction.ts";

test("cross-site out-of-process iframe and document :scope selectors", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/child")
      res.end(
        '<title>Child</title><main><h1>Cross site</h1><a href="/next">next</a></main>',
      );
    else if (req.url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
    } else
      res.end(
        `<title>Parent</title><main><p>parent text</p></main><iframe src="http://localhost:${(server.address() as any).port}/child"></iframe>`,
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    args: [
      "--site-per-process",
      "--host-resolver-rules=MAP localhost 127.0.0.1",
    ],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const child = page
      .frames()
      .find((frame) => frame.url().includes("/child"))!;
    // Confirm the fixture actually uses an out-of-process target.
    const session = await page.context().newCDPSession(child);
    await session.detach();
    const first = await extractPage(page, { selector: ":scope" });
    assert.match(first.text, /parent text/);
    const main = await extractPage(page, { selector: ":scope body > main" });
    assert.match(main.text, /parent text/);
    const frame = await extractPage(page, {
      frameSelector: ":scope body > iframe",
      selector: ":scope body > main",
    });
    assert.equal(frame.finalUrl, `http://localhost:${port}/child`);
    assert.equal(frame.requestedUrl, null);
    assert.equal(frame.title, "Child");
    assert.match(frame.text, /Cross site/);
    assert.deepEqual(frame.links, [
      { text: "next", url: `http://localhost:${port}/next` },
    ]);
    await assert.rejects(
      extractPage(page, { selector: ":scope, body" }),
      /exactly one/,
    );
    await assert.rejects(
      extractPage(page, { frameSelector: ":scope" }),
      /iframe or frame/,
    );
  } finally {
    await browser.close();
    server.close();
  }
});
