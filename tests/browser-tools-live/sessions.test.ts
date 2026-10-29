import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import { ManagedSessions } from "../../extensions/browser-tools/sessions.ts";

test("managed sessions isolate two factories and explicit tabs", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>${req.url}</title>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const make = () =>
    new ManagedSessions({
      launch: ({ headless }) =>
        chromium.launch({ headless, channel: "chromium" }),
    });
  const a = make(),
    b = make();
  try {
    const headless = process.env.BROWSER_HEADED !== "1";
    const first = await a.start({ headless });
    const second = await a.newTab(first.sessionId);
    const other = await b.start({ headless });
    await a.navigate(`http://127.0.0.1:${address.port}/one`, first);
    await a.navigate(`http://127.0.0.1:${address.port}/two`, second);
    assert.equal(
      a.list()[0].tabs.find((t) => t.tabId === first.tabId)?.url,
      `http://127.0.0.1:${address.port}/one`,
    );
    assert.equal(b.list()[0].tabs[0].url, "about:blank");
    await assert.rejects(
      b.navigate(`http://127.0.0.1:${address.port}/`, first),
      /Session unavailable/,
    );
    await a.closeTab(second);
    await assert.rejects(
      a.navigate(`http://127.0.0.1:${address.port}/`),
      /Session unavailable/,
    );
    assert.equal(b.list()[0].sessionId, other.sessionId);
  } finally {
    await Promise.all([a.shutdown(), b.shutdown()]);
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
