import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserDiagnostics } from "./diagnostics.ts";
import { sanitizeUrl } from "./redaction.ts";
import { SemanticSnapshots } from "./semantic-snapshots.ts";

test("URL metadata keeps safe HTTP destinations and omits opaque URLs", () => {
  const raw =
    "http://user:password@127.0.0.1:4321/path?view=ok&token=SECRET&X-Amz-Signature=SIGNATURE#PRIVATE";
  const safe = sanitizeUrl(raw);
  assert.match(safe, /127\.0\.0\.1:4321\/path/);
  assert.match(safe, /view=ok/);
  assert.doesNotMatch(safe, /user|password|SECRET|SIGNATURE|PRIVATE/);
  assert.equal(
    sanitizeUrl("https://example.test/path?q=hello"),
    "https://example.test/path?q=hello",
  );
  assert.equal(sanitizeUrl("about:blank"), "about:blank");
  assert.equal(sanitizeUrl("about:srcdoc"), "about:srcdoc");
  for (const url of [
    "data:text/html,SECRET",
    "DATA:text/html,SECRET",
    "file:///Users/me/SECRET?token=SECRET#SECRET",
    "about:SECRET",
    "about:blank#SECRET",
    "blob:https://example.test/SECRET",
    "javascript:SECRET",
  ]) {
    assert.equal(sanitizeUrl(url), "[non-HTTP URL omitted]", url);
  }
  assert.equal(sanitizeUrl("not a URL SECRET"), "[invalid URL]");
});

test("diagnostic request, frame, console and URL headers omit opaque payloads", async () => {
  const page = new EventEmitter();
  const d = new BrowserDiagnostics();
  const target = { sessionId: "s", tabId: "t" };
  d.attach(target, page as never);
  page.emit("console", {
    location: () => ({ url: "data:text/javascript,CONSOLE_SECRET" }),
    type: () => "log",
    text: () => "hello",
  });
  page.emit("request", {
    method: () => "GET",
    url: () => "http://localhost:3000/?token=REQUEST_SECRET&view=ok",
    resourceType: () => "fetch",
    frame: () => ({ url: () => "file:///FRAME_SECRET" }),
    redirectedFrom: () => null,
    allHeaders: async () => ({
      referer: "blob:https://example.test/HEADER_SECRET",
      location: "data:text/plain,LOCATION_SECRET",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const result = JSON.stringify(d.read(target));
  assert.doesNotMatch(
    result,
    /CONSOLE_SECRET|REQUEST_SECRET|FRAME_SECRET|HEADER_SECRET|LOCATION_SECRET/,
  );
  assert.match(result, /localhost:3000/);
  assert.match(result, /view=ok/);
  assert.match(result, /non-HTTP URL omitted/);
  d.shutdown();
});

test("snapshot metadata applies the same URL policy", async () => {
  class Page extends EventEmitter {
    current = "data:text/html,SNAPSHOT_SECRET";
    url() {
      return this.current;
    }
    async evaluate() {
      return { value: "title", truncated: false };
    }
    frames() {
      return [];
    }
  }
  const page = new Page();
  const snapshots = new SemanticSnapshots(page as never);
  try {
    assert.equal((await snapshots.snapshot()).url, "[non-HTTP URL omitted]");
    page.current = "http://localhost:4321/path?token=SECRET&view=ok#PRIVATE";
    const result = await snapshots.snapshot();
    assert.match(result.url, /localhost:4321\/path/);
    assert.match(result.url, /view=ok/);
    assert.doesNotMatch(result.url, /SECRET|PRIVATE/);
  } finally {
    await snapshots.dispose();
  }
});
