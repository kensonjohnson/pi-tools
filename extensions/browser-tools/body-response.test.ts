import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserDiagnostics } from "./diagnostics.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function request() {
  return {
    method: () => "POST",
    url: () => "http://localhost/save",
    resourceType: () => "fetch",
    frame: () => ({ url: () => "http://localhost/" }),
    redirectedFrom: () => null,
    allHeaders: async () => ({}),
    postDataBuffer: () => Buffer.from("x"),
  };
}
function emit(
  page: EventEmitter,
  headers: Record<string, string>,
  body: () => Promise<Buffer>,
  status = 400,
) {
  const req = request();
  page.emit("request", req);
  page.emit("response", {
    request: () => req,
    status: () => status,
    headers: () => headers,
    allHeaders: async () => headers,
    body,
  });
  page.emit("requestfinished", req);
}

test("response admission, exact bytes, and cursor updates", async () => {
  const d = new BrowserDiagnostics({ maxBodyBytes: 4, maxSessionBodyBytes: 8 });
  const p = new EventEmitter(),
    t = { sessionId: "s", tabId: "t" };
  d.attach(t, p as any);
  let calls = 0;
  const get = async () => {
    calls++;
    return Buffer.from("fail");
  };
  emit(p, { "content-length": "4" }, get);
  const seq = d.read(t).nextSequence;
  await tick();
  let rows = d.read(t, { afterSequence: seq }).requests;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body.response, "captured");
  assert.equal(
    Buffer.from(
      d.inspectBody(t, rows[0].id, "response").data!,
      "base64",
    ).toString(),
    "fail",
  );
  for (const h of [
    {},
    { "content-length": "5" },
    { "content-length": "4", "content-encoding": "gzip" },
    { "content-length": "4", "transfer-encoding": "chunked" },
    { "content-length": "4, 4" },
    { "content-length": "4", "content-type": "text/event-stream" },
  ])
    emit(p, h, get);
  await tick();
  rows = d.read(t).requests;
  assert.equal(calls, 1);
  assert.deepEqual(
    rows.slice(1).map((x) => x.body.response),
    [
      "unsupported",
      "oversized",
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported",
    ],
  );
  assert(rows.slice(1).every((x) => x.body.responseReason));
  d.shutdown();
});

test("unsettled reads hold global capacity across clear and collectors", async () => {
  const d = new BrowserDiagnostics(),
    p = new EventEmitter(),
    t = { sessionId: "a", tabId: "t" };
  d.attach(t, p as any);
  let release!: (value: Buffer) => void;
  const pending = new Promise<Buffer>((r) => {
    release = r;
  });
  emit(p, { "content-length": "1" }, () => pending);
  emit(p, { "content-length": "1" }, () => pending);
  await tick();
  d.clear(t);
  d.shutdown();
  const reloaded = await import("./diagnostics.ts?response-guard-reload");
  const d2 = new reloaded.BrowserDiagnostics(),
    p2 = new EventEmitter(),
    t2 = { sessionId: "b", tabId: "t" };
  d2.attach(t2, p2 as any);
  let called = false;
  emit(p2, { "content-length": "1" }, async () => {
    called = true;
    return Buffer.from("x");
  });
  assert.equal(d2.read(t2).requests[0].body.response, "unsupported");
  assert.match(d2.read(t2).requests[0].body.responseReason!, /capacity/);
  assert.equal(called, false);
  release(Buffer.from("x"));
  await tick();
  emit(p2, { "content-length": "1" }, async () => Buffer.from("x"));
  await tick();
  assert.equal(d2.read(t2).requests[1].body.response, "captured");
  d2.shutdown();
});

test("read errors and dishonest lengths are explicit", async () => {
  const d = new BrowserDiagnostics({ maxBodyBytes: 4, maxSessionBodyBytes: 8 });
  const p = new EventEmitter(),
    t = { sessionId: "s", tabId: "t" };
  d.attach(t, p as any);
  emit(p, { "content-length": "1" }, async () => Buffer.alloc(5));
  emit(p, { "content-length": "1" }, async () => {
    throw new Error("evicted");
  });
  await tick();
  assert.deepEqual(
    d.read(t).requests.map((r) => r.body.response),
    ["oversized", "failed"],
  );
  d.shutdown();
});
