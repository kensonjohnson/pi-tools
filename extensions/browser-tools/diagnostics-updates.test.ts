import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserDiagnostics } from "./diagnostics.ts";

const target = { sessionId: "s", tabId: "t" };
const tick = () => new Promise<void>((r) => setImmediate(r));
test("polling observes request lifecycle and asynchronous headers with stable IDs", async () => {
  const d = new BrowserDiagnostics();
  const page = new EventEmitter();
  d.attach(target, page as any);
  let resolve!: (value: Record<string, string>) => void;
  const req = {
    method: () => "GET",
    url: () => "https://example.test/a",
    resourceType: () => "fetch",
    frame: () => ({ url: () => "https://example.test/" }),
    redirectedFrom: () => null,
    allHeaders: async () => ({}),
    failure: () => ({ errorText: "connection reset" }),
  };
  page.emit("request", req);
  await tick();
  const pending = d.read(target);
  const id = pending.requests[0].id;
  page.emit("response", {
    request: () => req,
    status: () => 200,
    allHeaders: () => new Promise((r) => (resolve = r)),
  });
  await tick();
  const response = d.read(target, { afterSequence: pending.nextSequence });
  assert.equal(response.requests[0].id, id);
  assert.equal(response.requests[0].status, 200);
  assert.equal(response.requests[0].outcome, "pending");
  assert.equal(d.read(target, { afterId: id }).requests[0].outcome, "pending");
  resolve({ location: "/next?token=secret" });
  await tick();
  const headers = d.read(target, { afterSequence: response.nextSequence });
  assert.equal(headers.requests[0].id, id);
  assert.match(
    headers.requests[0].responseHeaders!.location,
    /https:\/\/example.test\/next\?token=/,
  );
  assert(!headers.requests[0].responseHeaders!.location.includes("secret"));
  page.emit("requestfailed", req);
  const failed = d.read(target, { afterSequence: headers.nextSequence });
  assert.equal(failed.requests[0].outcome, "transport-failure");
  assert.equal(failed.requests[0].status, 200);
  assert.equal(failed.requests[0].failure, "connection reset");
  assert.equal(
    d.read(target, { afterSequence: failed.nextSequence }).requests.length,
    0,
  );
  assert.throws(
    () => d.read(target, { afterSequence: 99999 }),
    /cursor unavailable/i,
  );
  const r2 = { ...req };
  page.emit("request", r2);
  page.emit("response", {
    request: () => r2,
    status: () => 404,
    allHeaders: async () => ({}),
  });
  assert.equal(
    d.read(target).requests.find((x) => x.id !== id)?.outcome,
    "pending",
  );
  page.emit("requestfinished", r2);
  assert.equal(
    d.read(target).requests.find((x) => x.id !== id)?.outcome,
    "http-error",
  );
  d.shutdown();
});
