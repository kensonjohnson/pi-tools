import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { launchFixtureBrowser } from "./download-test-helper.ts";
import { ArtifactStore } from "../../extensions/browser-tools/artifacts.ts";
import { TraceRecordings } from "../../extensions/browser-tools/recording.ts";
import { ManagedSessions } from "../../extensions/browser-tools/sessions.ts";

test(
  "owned native trace finalizes on session close into a private binary artifact",
  { timeout: 30000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "browser-trace-live-")),
    );
    const fixture = await launchFixtureBrowser(
      process.env.BROWSER_HEADED !== "1",
    );
    const artifacts = new ArtifactStore({ root: join(root, "artifacts") });
    const recordings = new TraceRecordings({
      sink: artifacts,
      durationMs: 30000,
      timeoutMs: 10000,
      maxBytes: 10_000_000,
    });
    const sessions = new ManagedSessions({
      launch: async () => fixture.browser,
      recordings,
    });
    try {
      const target = await sessions.start({ artifactOwner: "alice" });
      await sessions.trace("start", target.sessionId, "alice");
      await sessions.navigate(
        "data:text/html,<title>trace fixture</title><p>hello</p>",
        target,
        undefined,
        10000,
        "alice",
      );
      await sessions.stop(target.sessionId, 15000, undefined, "alice");
      const record = recordings.inspect(target.sessionId, "alice");
      assert.equal(record.state, "complete");
      assert.ok(record.artifact);
      const data = await readFile(record.artifact.path);
      assert.deepEqual(
        data.subarray(0, 4),
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      );
      const listing = execFileSync("unzip", ["-l", record.artifact.path], {
        encoding: "utf8",
      });
      assert.match(listing, /trace\.trace/);
      const chunk = await artifacts.readBinary("alice", record.artifact.id);
      assert.equal(chunk.encoding, "base64");
      await assert.rejects(
        artifacts.readBinary("bob", record.artifact.id),
        /not found|unavailable/i,
      );
    } finally {
      await sessions.shutdown(10000);
      await fixture.browser.close().catch(() => {});
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
