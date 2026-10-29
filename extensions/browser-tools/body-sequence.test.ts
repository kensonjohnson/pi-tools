import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserDiagnostics } from "./diagnostics.ts";

test("cross-tab body budget eviction updates the original tab cursor", () => {
  const d = new BrowserDiagnostics({ maxBodyBytes: 3, maxSessionBodyBytes: 3 });
  const a = new EventEmitter(),
    b = new EventEmitter(),
    ta = { sessionId: "s", tabId: "a" },
    tb = { sessionId: "s", tabId: "b" };
  d.attach(ta, a as any);
  d.attach(tb, b as any);
  const req = () => ({
    method: () => "POST",
    url: () => "http://localhost/",
    resourceType: () => "fetch",
    frame: () => ({ url: () => "http://localhost/" }),
    redirectedFrom: () => null,
    allHeaders: async () => ({}),
    postDataBuffer: () => Buffer.from([1, 2, 3]),
  });
  a.emit("request", req());
  const before = d.read(ta);
  assert.equal(before.requests[0].body.request, "captured");
  b.emit("request", req());
  const after = d.read(ta, { afterSequence: before.nextSequence });
  assert.equal(after.requests.length, 1);
  assert.equal(after.requests[0].body.request, "evicted");
  assert(after.nextSequence > before.nextSequence);
  d.shutdown();
});
