import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractPage,
  registerExtractionTools,
} from "../../extensions/browser-tools/extraction.ts";
import { ArtifactStore } from "../../extensions/browser-tools/artifacts.ts";
import { chunkOutput } from "../../extensions/browser-tools/output.ts";

test("rendered extraction preserves page provenance, scope, frames and complete Unicode artifacts", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    requests.push(req.url!);
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/one" });
      res.end();
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/frame") {
      res.end(
        '<title>Frame</title><h2>Frame heading</h2><p>Frame text <a href="/two">next</a></p>',
      );
      return;
    }
    if (req.url === "/two") {
      res.end("<title>Second</title><p>second page</p>");
      return;
    }
    res.end(
      `<!doctype html><title>First</title><div id="outside">outside-secret</div><div id="scope"><h1>Rendered</h1><a href="/two">next page</a><span hidden>hidden-secret</span><input value="field-secret"><p id="dynamic"></p></div><div hidden><p id="hidden-child">hidden-parent-secret</p></div><iframe src="/frame"></iframe><script>document.querySelector('#dynamic').textContent='rendered text';</script>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium",
  });
  const root = await realpath(await mkdtemp(join(tmpdir(), "extract-test-")));
  try {
    const page = await browser.newPage();
    await page.goto(base + "/redirect");
    const before = requests.length;
    const first = await extractPage(
      page,
      { selector: "#scope" },
      base + "/redirect",
    );
    assert.equal(first.requestedUrl, base + "/redirect");
    assert.equal(first.finalUrl, base + "/one");
    assert.equal(first.title, "First");
    assert.equal(first.publicationTime, null);
    assert.ok(!Number.isNaN(Date.parse(first.retrievedAt)));
    assert.match(first.text, /rendered text/);
    assert.doesNotMatch(
      first.text,
      /outside-secret|hidden-secret|field-secret/,
    );
    assert.deepEqual(first.links, [{ text: "next page", url: base + "/two" }]);
    assert.deepEqual(first.headings, [{ level: 1, text: "Rendered" }]);
    const frame = await extractPage(
      page,
      { frameSelector: "iframe" },
      base + "/redirect",
    );
    assert.equal(frame.requestedUrl, null);
    assert.equal(frame.finalUrl, base + "/frame");
    assert.match(frame.text, /Frame text/);
    assert.equal(requests.length, before);
    await assert.rejects(
      extractPage(page, { selector: "#hidden-child" }),
      /hidden/,
    );
    await assert.rejects(
      extractPage(page, { selector: "missing" }),
      /exactly one/,
    );
    await page.goto(base + "/two");
    const second = await extractPage(page);
    assert.equal(second.title, "Second");
    assert.equal(second.requestedUrl, null);
    assert.equal(second.finalUrl, base + "/two");
    await page.evaluate(() => {
      document.body.innerHTML = "<p>" + "é🙂".repeat(12000) + "</p>";
    });
    const tools = new Map<string, any>();
    const store = new ArtifactStore({ root: join(root, "artifacts") });
    registerExtractionTools(
      { registerTool: (t: any) => tools.set(t.name, t) } as any,
      () => ({
        artifacts: store,
        owner: "owner",
        runPage: async (_target, _signal, work) =>
          work(page, { sessionId: "s", tabId: "t" }, null),
      }),
    );
    const response = await tools.get("browser_extract").execute("id", {});
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.complete, false);
    let text = "",
      offset = 0;
    for (;;) {
      const chunk = JSON.parse(
        await chunkOutput(store, "owner", result.artifact.id, offset, 4096),
      );
      text += chunk.text;
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
    assert.equal(JSON.parse(text).text, "é🙂".repeat(12000));
    await assert.rejects(
      chunkOutput(store, "other", result.artifact.id, 0, 100),
      /owned by another/,
    );
  } finally {
    await browser.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
