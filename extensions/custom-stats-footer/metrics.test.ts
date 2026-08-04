import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ResponseTpsMeter } from "./metrics.ts";

function response(
  output: number,
  stopReason: AssistantMessage["stopReason"] = "stop",
): Pick<AssistantMessage, "stopReason" | "usage"> {
  return {
    stopReason,
    usage: {
      input: 0,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("measures one response without counting a later tool gap", () => {
  let now = 0;
  const meter = new ResponseTpsMeter(() => now);

  meter.start();
  now = 2_000;
  assert.equal(meter.finish(response(100)), true);

  now += 300_000;
  assert.deepEqual(meter.snapshot(), { lastTps: 50, averageTps: 50 });
});

test("weights the aggregate by output tokens and response duration", () => {
  let now = 0;
  const meter = new ResponseTpsMeter(() => now);

  meter.start();
  now = 2_000;
  meter.finish(response(100));
  meter.start();
  now = 3_000;
  meter.finish(response(10));

  const snapshot = meter.snapshot();
  assert.equal(snapshot.lastTps, 10);
  assert.equal(snapshot.averageTps, 110 / 3);
  assert.notEqual(snapshot.averageTps, 30);
});

test("discards invalid responses without changing finalized metrics", () => {
  let now = 0;
  const meter = new ResponseTpsMeter(() => now);

  meter.start();
  now = 1_000;
  meter.finish(response(50));
  const finalized = meter.snapshot();

  assert.equal(meter.finish(response(50)), false);
  meter.start();
  now = 2_000;
  assert.equal(meter.finish(response(0)), false);
  meter.start();
  now = 3_000;
  assert.equal(meter.finish(response(50, "error")), false);
  meter.start();
  now = 4_000;
  assert.equal(meter.finish(response(50, "aborted")), false);
  meter.start();
  assert.equal(meter.finish(response(50)), false);

  assert.deepEqual(meter.snapshot(), finalized);
});

test("resets active and aggregate state for a new session", () => {
  let now = 0;
  const meter = new ResponseTpsMeter(() => now);

  meter.start();
  now = 1_000;
  meter.finish(response(50));
  meter.start();
  meter.reset();
  now = 2_000;

  assert.equal(meter.finish(response(50)), false);
  assert.deepEqual(meter.snapshot(), { lastTps: null, averageTps: null });
});
