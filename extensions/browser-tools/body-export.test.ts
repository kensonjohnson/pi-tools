import { test } from "node:test";
import assert from "node:assert/strict";
import { BodyCapture } from "./body-capture.ts";

test("injected binary sink is capacity bounded and cancelled on eviction", async () => {
  const signals: AbortSignal[] = [];
  const sink = async (_owner: string, _bytes: Buffer, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  };
  const c = new BodyCapture(4, 4, sink);
  c.start("s", true);
  c.begin("s", "t", "a");
  c.set("s", "t", "a", "request", "captured", Buffer.from([0, 255]));
  const a = c.export("s", "t", "a", "request", "owner"),
    b = c.export("s", "t", "a", "request", "owner");
  await assert.rejects(c.export("s", "t", "a", "request", "owner"), /capacity/);
  c.drop("s", "t", "a");
  await Promise.all([a, b]);
  assert(signals.every((signal) => signal.aborted));
});
