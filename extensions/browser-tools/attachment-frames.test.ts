import { test } from "node:test";
import assert from "node:assert/strict";
import { AttachmentFrameLimit } from "./attachment-frames.ts";

function frame(op: number, fin: boolean, body: string, masked = false) {
  const bytes = Buffer.from(body);
  return Buffer.concat([
    Buffer.from([(fin ? 128 : 0) | op, bytes.length | (masked ? 128 : 0)]),
    ...(masked ? [Buffer.alloc(4)] : []),
    bytes,
  ]);
}
test("frame limit tracks fragmented messages and allows control frames", async () => {
  const limiter = new AttachmentFrameLimit(false, 5);
  let result = Buffer.alloc(0);
  limiter.on("data", (chunk) => {
    result = Buffer.concat([result, chunk]);
  });
  const wire = Buffer.concat([
    frame(1, false, "12"),
    frame(9, true, "p"),
    frame(0, true, "345"),
  ]);
  for (const byte of wire) limiter.write(Buffer.from([byte]));
  limiter.end();
  await new Promise<void>((resolve, reject) => {
    limiter.once("end", resolve);
    limiter.once("error", reject);
  });
  assert.deepEqual(result, wire);
});
test("frame limit rejects fragmented excess, unmasked client and oversized 64-bit headers", async () => {
  for (const [masked, wire] of [
    [false, Buffer.concat([frame(1, false, "123"), frame(0, true, "456")])],
    [true, frame(1, true, "x")],
    [false, Buffer.from([0x81, 127, 0, 0, 0, 0, 0, 0, 1, 0])],
  ] as const) {
    const limiter = new AttachmentFrameLimit(masked, 5);
    const error = new Promise<Error>((resolve) =>
      limiter.once("error", resolve),
    );
    limiter.write(wire);
    assert.match((await error).message, /limit|frame/i);
  }
});
