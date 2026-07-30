import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RawOutputCaptureError,
  captureBashRawOutput,
  probeBashRawOutput,
} from "./raw-capture.ts";

test("uses visible text when Pi has no successful full-output path", async () => {
  assert.deepEqual(await captureBashRawOutput({}, "visible output", 100), {
    content: "visible output",
    source: "visible",
  });
});

test("recovers a bounded UTF-8 regular Pi full-output file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-raw-capture-"));
  try {
    const path = join(root, "full-output.txt");
    await writeFile(path, "full 🌍 output", "utf8");
    assert.deepEqual(
      await captureBashRawOutput({ fullOutputPath: path }, "visible", 100),
      { content: "full 🌍 output", source: "full-output-path" },
    );

    await assert.rejects(
      captureBashRawOutput({ fullOutputPath: path }, "visible", 4),
      RawOutputCaptureError,
    );
    const link = join(root, "link.txt");
    await symlink(path, link);
    await assert.rejects(
      captureBashRawOutput({ fullOutputPath: link }, "visible", 100),
      RawOutputCaptureError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("probes bounded binary head/tail bytes before full raw capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-raw-probe-"));
  try {
    const path = join(root, "full-output.txt");
    await writeFile(path, "prefix 🌍 middle suffix", "utf8");
    const probe = await probeBashRawOutput({ fullOutputPath: path }, 100, 7);
    assert.ok(probe);
    assert.equal(
      probe.byteLength,
      Buffer.byteLength("prefix 🌍 middle suffix"),
    );
    assert.equal(probe.head.toString("utf8"), "prefix ");
    assert.equal(probe.tail.toString("utf8"), " suffix");
    assert.equal(await probeBashRawOutput({}, 100, 7), undefined);
    await assert.rejects(
      probeBashRawOutput({ fullOutputPath: path }, 100, 0),
      RawOutputCaptureError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects cancellation and invalid paths rather than guessing raw content", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    captureBashRawOutput({}, "visible", 100, controller.signal),
    RawOutputCaptureError,
  );
  await assert.rejects(
    captureBashRawOutput(
      { fullOutputPath: "relative/path.txt" },
      "visible",
      100,
    ),
    RawOutputCaptureError,
  );
});
