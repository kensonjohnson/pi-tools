import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ArtifactStore } from "../../extensions/browser-tools/artifacts.ts";
import { VideoRecordings } from "../../extensions/browser-tools/video-recording.ts";
import { TraceRecordings } from "../../extensions/browser-tools/recording.ts";
import { ManagedSessions } from "../../extensions/browser-tools/sessions.ts";

test(
  "new recording-enabled context saves a playable native video after close",
  { timeout: 30000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "browser-video-live-")),
    );
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADED !== "1",
      channel: "chromium",
    });
    const artifacts = new ArtifactStore({ root: join(root, "artifacts") });
    const videos = new VideoRecordings({
      sink: artifacts,
      durationMs: 30000,
      timeoutMs: 10000,
      maxBytes: 10_000_000,
    });
    const recordings = new TraceRecordings({
      sink: artifacts,
      durationMs: 30000,
      timeoutMs: 10000,
      maxBytes: 10_000_000,
    });
    const sessions = new ManagedSessions({
      launch: async () => browser,
      videos,
      recordings,
    });
    try {
      const target = await sessions.start({
        artifactOwner: "alice",
        video: true,
      });
      assert.equal(
        videos.inspect(target.sessionId, "alice").state,
        "recording",
      );
      assert.throws(
        () => videos.inspect(target.sessionId, "bob"),
        /unavailable/,
      );
      await sessions.trace("start", target.sessionId, "alice");
      await sessions.navigate(
        "data:text/html,<title>video</title><h1>local fixture</h1><button onclick=\"this.textContent='clicked'\">run</button>",
        target,
        undefined,
        10000,
        "alice",
      );
      await sessions.withOwnedPage(target, undefined, "alice", async (page) => {
        await page.getByRole("button", { name: "run" }).click();
        // A static scene held across compositor frames exercises encoder flushing.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              let frames = 0;
              const tick = () => {
                if (++frames === 100) resolve();
                else requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            }),
        );
      });
      const trace = await sessions.trace("stop", target.sessionId, "alice");
      assert.equal(trace.state, "complete");
      await sessions.stop(target.sessionId, 15000, undefined, "alice");
      const record = videos.inspect(target.sessionId, "alice");
      assert.equal(record.state, "complete");
      assert.equal(record.videos.length, 1);
      const artifact = record.videos[0].artifact;
      assert.ok(artifact);
      assert.ok(artifact.bytes > 0);
      const chunk = await artifacts.readBinary("alice", artifact.id);
      assert.equal(chunk.encoding, "base64");
      await assert.rejects(
        artifacts.readBinary("bob", artifact.id),
        /not found|unavailable/i,
      );
      if (spawnSync("ffprobe", ["-version"]).status === 0) {
        const probe = JSON.parse(
          execFileSync(
            "ffprobe",
            [
              "-v",
              "error",
              "-show_entries",
              "stream=codec_name,codec_type,width,height:format=duration",
              "-of",
              "json",
              artifact.path,
            ],
            { encoding: "utf8" },
          ),
        );
        assert.equal(probe.streams[0].codec_type, "video");
        assert.match(probe.streams[0].codec_name, /^vp[89]$/);
        assert.ok(probe.streams[0].width > 0);
        assert.ok(probe.streams[0].height > 0);
        assert.ok(Number(probe.format.duration) > 0);
      }
    } finally {
      await sessions.shutdown(10000);
      await browser.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);
