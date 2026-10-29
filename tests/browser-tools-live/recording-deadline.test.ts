import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { ArtifactStore } from "../../extensions/browser-tools/artifacts.ts";
import { VideoRecordings } from "../../extensions/browser-tools/video-recording.ts";
import { ManagedSessions } from "../../extensions/browser-tools/sessions.ts";

test(
  "video deadline closes the owned session and finalizes",
  { timeout: 30000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "browser-video-deadline-")),
    );
    const videos = new VideoRecordings({
      sink: new ArtifactStore({ root: join(root, "store") }),
      durationMs: 1000,
      timeoutMs: 10000,
      maxBytes: 10_000_000,
    });
    const sessions = new ManagedSessions({
      launch: ({ headless }) =>
        chromium.launch({ headless, channel: "chromium" }),
      videos,
    });
    try {
      const target = await sessions.start({
        headless: process.env.BROWSER_HEADED !== "1",
        video: true,
        artifactOwner: "alice",
      });
      await sessions.navigate(
        "data:text/html,<h1>deadline</h1>",
        target,
        undefined,
        10000,
        "alice",
      );
      for (
        let n = 0;
        n < 200 &&
        !["complete", "failed"].includes(
          videos.inspect(target.sessionId, "alice").state,
        );
        n++
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(videos.inspect(target.sessionId, "alice").state, "complete");
      assert.equal(sessions.list("alice").length, 0);
    } finally {
      await sessions.shutdown(10000);
      await rm(root, { recursive: true, force: true });
    }
  },
);
