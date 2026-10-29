import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BodyCapture } from "./body-capture.ts";
import { BrowserDiagnostics } from "./diagnostics.ts";

test("retention is bounded, deterministic and exact, including binary", () => {
  const c = new BodyCapture(4, 6);
  c.start("s", true);
  c.begin("s", "t", "a");
  c.set("s", "t", "a", "request", "captured", Buffer.from([0, 255, 1, 2]));
  const chunk = c.inspect("s", "t", "a", "request", 0, 2);
  assert.equal(chunk.data, "AP8=");
  assert.equal(chunk.nextOffset, 2);
  c.begin("s", "t", "b");
  c.set("s", "t", "b", "request", "captured", Buffer.from([3, 4, 5]));
  assert.equal(c.state("s", "t", "a", "request"), "evicted");
  c.begin("s", "t", "c");
  c.set("s", "t", "c", "request", "captured", Buffer.alloc(5));
  assert.equal(c.state("s", "t", "c", "request"), "oversized");
  c.drop("s", "t", "b");
  assert.throws(() => c.inspect("s", "t", "b", "request"));
  c.end("s");
  assert.throws(() => c.inspect("s", "t", "c", "request"));
});

test("research starts disabled, enabling applies only to new requests", () => {
  const d = new BrowserDiagnostics();
  const page = new EventEmitter();
  const t = { sessionId: "s", tabId: "t" };
  d.attach(t, page as any, false, "research");
  const request = () => ({
    method: () => "POST",
    url: () => "http://local/",
    resourceType: () => "fetch",
    frame: () => ({ url: () => "http://local/" }),
    redirectedFrom: () => null,
    allHeaders: async () => ({}),
    postDataBuffer: () => Buffer.from("secret"),
  });
  page.emit("request", request());
  let entries = d.read(t).requests;
  assert.equal(entries[0].body.request, "disabled");
  d.configureBodies(t, true);
  page.emit("request", request());
  entries = d.read(t).requests;
  assert.equal(entries[1].body.request, "captured");
  assert(!JSON.stringify(entries).includes("secret"));
  const data = d.inspectBody(t, entries[1].id, "request");
  assert.equal(Buffer.from(data.data!, "base64").toString(), "secret");
  d.clear(t);
  assert.throws(() => d.inspectBody(t, entries[1].id, "request"));
  d.shutdown();
});
