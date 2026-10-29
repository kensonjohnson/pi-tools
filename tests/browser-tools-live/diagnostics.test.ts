import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import { BrowserDiagnostics } from "../../extensions/browser-tools/diagnostics.ts";

test("page-scoped native diagnostics capture redirects, failures and scoped headers", async () => {
  let slowResponse: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url === "/slow") {
      slowResponse = res;
      res.writeHead(200, { "content-type": "text/plain" });
      res.flushHeaders();
      return;
    }
    if (req.url === "/drop") {
      req.socket.destroy();
      return;
    }
    if (req.url?.startsWith("/redirect")) {
      res.writeHead(302, { location: "/final?token=secret" });
      res.end();
      return;
    }
    if (req.url?.startsWith("/final")) {
      res.writeHead(401, { "set-cookie": "sid=secret; HttpOnly" });
      res.end("no");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>fixture</title>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
  });
  const diagnostics = new BrowserDiagnostics();
  const context = await browser.newContext();
  const page = await context.newPage();
  const other = await context.newPage();
  const target = { sessionId: "s", tabId: "t" };
  diagnostics.attach(target, page);
  try {
    await page.goto(`http://127.0.0.1:${address.port}/redirect?token=secret`);
    await page.evaluate(() => {
      console.warn("fixture warning");
      setTimeout(() => {
        throw new Error("fixture exception");
      }, 0);
      Promise.reject(new Error("fixture rejection"));
      void fetch("/drop").catch(() => {});
    });
    await other.goto(`http://127.0.0.1:${address.port}/unrelated`);
    await page.waitForTimeout(200);
    const result = diagnostics.read(target);
    assert(result.logs.some((x) => x.text.includes("fixture warning")));
    assert(
      result.logs.some(
        (x) => x.level === "pageerror" && x.text.includes("fixture exception"),
      ),
    );
    const first = result.requests.find((x) => x.status === 302)!;
    const last = result.requests.find((x) => x.status === 401)!;
    assert(first && last);
    assert.match(first.responseHeaders?.location ?? "", /\/final\?token=/);
    assert(!first.responseHeaders?.location?.includes("secret"));
    assert(
      result.logs.some(
        (x) => x.level === "pageerror" && x.text.includes("fixture rejection"),
      ),
    );
    assert(
      result.requests.some(
        (x) => x.url.endsWith("/drop") && x.outcome === "transport-failure",
      ),
    );
    assert.equal(last.redirectedFrom, first.id);
    assert.equal(last.outcome, "http-error");
    assert(!JSON.stringify(result).includes("token=secret"));
    assert(!JSON.stringify(result).includes("sid=secret"));
    assert(!result.requests.some((x) => x.url.includes("unrelated")));
    assert.match(
      diagnostics.inspectHeaders(target, last.id, "response", ["set-cookie"])
        .values["set-cookie"],
      /sid=secret/,
    );
    assert.throws(() => diagnostics.read({ sessionId: "other", tabId: "t" }));
    const responsePromise = page.waitForResponse((r) =>
      r.url().endsWith("/slow"),
    );
    await page.evaluate(() => {
      void fetch("/slow").then((r) => r.text());
    });
    await responsePromise;
    const beforeFinish = diagnostics.read(target);
    const slow = beforeFinish.requests.find((x) => x.url.endsWith("/slow"))!;
    assert(slow);
    assert.equal(slow.status, 200);
    assert.equal(slow.outcome, "pending");
    const finishedPromise = page.waitForEvent("requestfinished", (r) =>
      r.url().endsWith("/slow"),
    );
    slowResponse!.end("done");
    await finishedPromise;
    const afterFinish = diagnostics.read(target, {
      afterSequence: beforeFinish.nextSequence,
    });
    assert.equal(
      afterFinish.requests.find((x) => x.id === slow.id)?.outcome,
      "success",
    );
  } finally {
    diagnostics.shutdown();
    await context.close();
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
