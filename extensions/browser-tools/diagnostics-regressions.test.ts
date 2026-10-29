import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserDiagnostics } from "./diagnostics.ts";
import { sanitizeHeaders } from "./redaction.ts";

const target = { sessionId: "s", tabId: "t" };
const request = (headers: () => Promise<Record<string, string>>) => ({
  method: () => "GET",
  url: () => "https://example.test/",
  resourceType: () => "fetch",
  frame: () => ({ url: () => "https://example.test/" }),
  redirectedFrom: () => null,
  allHeaders: headers,
});
const log = (text: string, level = "log") => ({
  location: () => ({ url: "https://example.test/" }),
  type: () => level,
  text: () => text,
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("multiline and comma-separated set-cookie values never appear in default output", () => {
  const h = sanitizeHeaders({
    "set-cookie":
      "sid=secret1; HttpOnly\nother=secret2; Secure\r\nthird=secret3; Expires=Wed, 21 Oct 2030 07:28:00 GMT, fourth=secret4; SameSite=Lax",
  });
  for (let i = 1; i <= 4; i++)
    assert(!h["set-cookie"].includes(`secret${i}`), h["set-cookie"]);
  assert.match(h["set-cookie"], /sid=\[redacted\]; HttpOnly/);
  assert.match(h["set-cookie"], /other=\[redacted\]; Secure/);
  assert.match(h["set-cookie"], /fourth=\[redacted\]/);
});

test("one page has one owner across collectors and can be reattached after release", () => {
  const page = new EventEmitter();
  const a = new BrowserDiagnostics();
  const b = new BrowserDiagnostics();
  a.attach(target, page as any);
  assert.throws(
    () => a.attach({ sessionId: "other", tabId: "tab" }, page as any),
    /owned/,
  );
  assert.throws(
    () => b.attach({ sessionId: "other", tabId: "tab" }, page as any),
    /owned/,
  );
  a.endSession("s");
  b.attach({ sessionId: "other", tabId: "tab" }, page as any);
  page.emit("console", log("new owner"));
  assert.equal(b.read({ sessionId: "other", tabId: "tab" }).logs.length, 1);
  b.shutdown();
});

test("clear renews header capacity without allowing unbounded stalled reads", async () => {
  const page = new EventEmitter();
  const d = new BrowserDiagnostics({ maxPendingHeaders: 1 });
  d.attach(target, page as any);
  let resolve!: (value: Record<string, string>) => void;
  let calls = 0;
  page.emit(
    "request",
    request(() => {
      calls++;
      return new Promise((r) => (resolve = r));
    }),
  );
  await tick();
  d.clear(target);
  page.emit(
    "request",
    request(async () => {
      calls++;
      return { authorization: "fresh" };
    }),
  );
  await tick();
  let item = d.read(target).requests[0];
  assert.equal(item.headerState.request, "complete");
  assert.equal(
    d.inspectHeaders(target, item.id, "request", ["authorization"]).values
      .authorization,
    "fresh",
  );
  d.clear(target);
  page.emit(
    "request",
    request(() => {
      calls++;
      return new Promise(() => {});
    }),
  );
  await tick();
  d.clear(target);
  page.emit(
    "request",
    request(async () => {
      calls++;
      return {};
    }),
  );
  await tick();
  item = d.read(target).requests[0];
  assert.equal(item.headerState.request, "partial");
  assert.equal(calls, 3);
  resolve({ authorization: "stale" });
  await tick();
  assert.equal(d.read(target).requests[0].headerState.request, "partial");
  d.shutdown();
});

test("cursor uses unfiltered global event order and stream-specific filters", async () => {
  let id = 0;
  const d = new BrowserDiagnostics({ id: () => String(++id), now: () => 1 });
  const page = new EventEmitter();
  d.attach(target, page as any);
  page.emit("console", log("before"));
  const r = request(async () => ({}));
  page.emit("request", r);
  page.emit("console", log("after", "warning"));
  const r2 = request(async () => ({}));
  page.emit("request", r2);
  page.emit("response", {
    request: () => r2,
    status: () => 404,
    allHeaders: async () => ({}),
  });
  await tick();
  const all = d.read(target);
  const cursor = all.requests[0].id;
  const after = d.read(target, { afterId: cursor });
  assert.deepEqual(
    after.logs.map((x) => x.text),
    ["after"],
  );
  assert(after.requests.some((x) => x.id === all.requests[0].id));
  assert(after.requests.some((x) => x.id === all.requests[1].id));
  const filtered = d.read(target, { afterId: cursor, level: "warning" });
  assert.deepEqual(
    filtered.logs.map((x) => x.text),
    ["after"],
  );
  assert.equal(filtered.requests.length, 0);
  const status = d.read(target, { afterId: all.logs[0].id, status: 404 });
  assert.equal(status.logs.length, 0);
  assert.equal(status.requests.length, 1);
  assert.equal(d.read(target, { resourceType: "fetch" }).logs.length, 0);
  assert.throws(
    () => d.read(target, { afterId: "unknown" }),
    /Cursor unavailable/,
  );
  d.shutdown();
});
