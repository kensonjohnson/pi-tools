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
  "named owned profile can request video at persistent context creation",
  { timeout: 30000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "browser-video-profile-")),
    );
    const store = new ArtifactStore({ root: join(root, "store") });
    const videos = new VideoRecordings({
      sink: store,
      durationMs: 30000,
      timeoutMs: 10000,
      maxBytes: 10_000_000,
    });
    const sessions = new ManagedSessions({
      profileRoot: join(root, "profiles"),
      launch: ({ headless }) =>
        chromium.launch({ headless, channel: "chromium" }),
      launchPersistent: (path, { headless, recordVideo }) =>
        chromium.launchPersistentContext(path, {
          headless,
          recordVideo,
          channel: "chromium",
        }),
      videos,
    });
    try {
      const target = await sessions.start({
        profile: "local",
        headless: process.env.BROWSER_HEADED !== "1",
        video: true,
        artifactOwner: "alice",
      });
      await sessions.navigate(
        "data:text/html,<h1>profile fixture</h1>",
        target,
        undefined,
        10000,
        "alice",
      );
      await sessions.withOwnedPage(target, undefined, "alice", (page) =>
        page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        ),
      );
      await sessions.stop(target.sessionId, 15000, undefined, "alice");
      const record = videos.inspect(target.sessionId, "alice");
      assert.equal(record.state, "complete");
      assert.ok(record.videos.some((video) => video.artifact));
    } finally {
      await sessions.shutdown(10000);
      await rm(root, { recursive: true, force: true });
    }
  },
);
