import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserDiagnostics } from "./diagnostics.ts";

test("response inspection and explicit export retain exact bounded binary bytes", async () => {
  let exported: Buffer | undefined;
  let exportOwner = "";
  const d = new BrowserDiagnostics({
    maxBodyBytes: 4,
    maxSessionBodyBytes: 4,
    bodyArtifactSink: async (owner, bytes) => {
      exportOwner = owner;
      exported = Buffer.from(bytes);
      return { size: bytes.length };
    },
  });
  const p = new EventEmitter(),
    t = { sessionId: "s", tabId: "t" };
  d.attach(t, p as any);
  const req = {
    method: () => "GET",
    url: () => "http://localhost/",
    resourceType: () => "fetch",
    frame: () => ({ url: () => "http://localhost/" }),
    redirectedFrom: () => null,
    allHeaders: async () => ({}),
    postDataBuffer: () => null,
  };
  const bytes = Buffer.from([0, 255, 1, 2]);
  p.emit("request", req);
  p.emit("response", {
    request: () => req,
    status: () => 200,
    headers: () => ({ "content-length": "4" }),
    allHeaders: async () => ({}),
    body: async () => bytes,
  });
  p.emit("requestfinished", req);
  await new Promise<void>((r) => setImmediate(r));
  const id = d.read(t).requests[0].id;
  assert.deepEqual(await d.exportBody(t, id, "response", "owner"), { size: 4 });
  assert.equal(exportOwner, "owner");
  assert.deepEqual(exported, bytes);
  const chunk = d.inspectBody(t, id, "response", 1, 2);
  assert.deepEqual(Buffer.from(chunk.data!, "base64"), bytes.subarray(1, 3));
  assert.equal(chunk.nextOffset, 3);
  assert.throws(
    () => d.inspectBody({ sessionId: "other", tabId: "t" }, id, "response"),
    /unavailable/,
  );
  d.shutdown();
});
