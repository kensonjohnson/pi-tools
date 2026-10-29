import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserDiagnostics } from "./diagnostics.ts";
import { sanitizeUrl, sanitizeHeaders } from "./redaction.ts";

test("redacts known URL credentials and cookie values", () => {
  assert(
    !sanitizeUrl(
      "https://user:pass@example.test/?token=secret#secret",
    ).includes("secret"),
  );
  const result = sanitizeHeaders({
    cookie: "sid=secret; x=other",
    "set-cookie": "sid=secret; HttpOnly",
    authorization: "Bearer secret",
  });
  assert(!JSON.stringify(result).includes("secret"));
  assert.match(result["set-cookie"], /HttpOnly/);
});

test("bounded histories isolate tabs and ignore late headers after clear or close", async () => {
  const page = new EventEmitter();
  const other = new EventEmitter();
  const d = new BrowserDiagnostics({ maxEntries: 2, maxFieldBytes: 64 });
  const target = { sessionId: "a", tabId: "1" };
  d.attach(target, page as any);
  d.attach({ sessionId: "b", tabId: "2" }, other as any, true);
  const message = (text: string) => ({
    location: () => ({ url: "https://example.test/?token=secret" }),
    type: () => "log",
    text: () => text,
  });
  for (let i = 0; i < 3; i++) page.emit("console", message("x".repeat(500)));
  assert.equal(d.read(target).logs.length, 2);
  assert.equal(d.read(target).evictedLogs, 1);
  assert.equal(d.read({ sessionId: "b", tabId: "2" }).logs.length, 0);
  let resolve!: (headers: Record<string, string>) => void;
  const request = {
    method: () => "GET",
    url: () => "https://example.test/?token=secret",
    resourceType: () => "fetch",
    frame: () => ({ url: () => "https://example.test/" }),
    redirectedFrom: () => null,
    allHeaders: () => new Promise<Record<string, string>>((r) => (resolve = r)),
  };
  page.emit("request", request);
  await Promise.resolve();
  d.clear(target);
  resolve({ authorization: "Bearer secret" });
  await new Promise((r) => setImmediate(r));
  assert.equal(d.read(target).requests.length, 0);
  d.endSession("a");
  assert.equal(page.listenerCount("request"), 0);
  assert.throws(() => d.read(target));
  d.shutdown();
});
