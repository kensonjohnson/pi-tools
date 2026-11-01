import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { rm } from "node:fs/promises";
import { DownloadManager } from "./downloads.ts";
import { ManagedSessions } from "./sessions.ts";
import { VideoRecordings } from "./video-recording.ts";

test(
  "video deadline closes owned browser and records owner-scoped native download risk",
  { timeout: 10000 },
  async () => {
    let closed = false;
    const page = new EventEmitter() as any,
      browser = new EventEmitter() as any,
      context = new EventEmitter() as any;
    page.isClosed = () => closed;
    page.url = () => "about:blank";
    page.video = () => ({ path: async () => "/not-a-native-video" });
    page.close = async () => {
      closed = true;
      page.emit("close");
    };
    context.pages = () => [];
    context.newPage = async () => page;
    context.close = async () => {
      await page.close();
    };
    browser.newContext = async () => context;
    browser.close = async () => {
      await page.close();
      browser.emit("disconnected");
    };
    const downloads = new DownloadManager({
      sink: {
        putBinary: async () => {
          throw new Error("quota exceeded");
        },
      },
      operationTimeoutMs: 1000,
    });
    const videos = new VideoRecordings({
      sink: {
        putBinary: async () => {
          throw new Error("unexpected");
        },
      },
      durationMs: 100,
      timeoutMs: 1000,
      maxBytes: 1000,
    });
    const notifications: { owner: string; session: string; count: number }[] =
      [];
    const sessions = new ManagedSessions({
      launch: async () => browser,
      downloads,
      videos,
      onVideoDeadlineRisk: (owner, session, count) =>
        notifications.push({ owner, session, count }),
    });
    let recovery: string | undefined;
    try {
      const target = await sessions.start({
        video: true,
        headless: true,
        artifactOwner: "owner",
      });
      page.emit("download", {
        url: () => "https://example.test/file",
        suggestedFilename: () => "a",
        failure: async () => null,
        createReadStream: async () => Readable.from([Buffer.from("retained")]),
        cancel: async () => {},
        delete: async () => {},
      });
      const id = downloads.list(target.sessionId)[0].id;
      assert.equal(
        (await downloads.wait(target.sessionId, id)).nativeRecovery,
        "available_until_session_close",
      );
      page.emit("download", {
        url: () => "https://example.test/pending",
        suggestedFilename: () => "b",
        failure: () => new Promise(() => {}),
        createReadStream: async () => null,
        cancel: async () => {},
        delete: async () => {},
      });
      for (let i = 0; i < 100 && !closed; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(closed, true);
      for (
        let i = 0;
        i < 100 &&
        downloads.inspect(target.sessionId, id).nativeRecovery !==
          "unknown_after_close";
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(
        downloads.inspect(target.sessionId, id).nativeRecovery,
        "unknown_after_close",
      );
      const video = videos.inspect(target.sessionId, "owner");
      assert.equal(video.deadlineClosure?.reason, "deadline");
      assert.equal(video.deadlineClosure?.riskAssessment, "observed");
      assert.ok(
        video.deadlineClosure?.downloadRisks.some((item) => item.id === id),
      );
      assert.ok(
        video.deadlineClosure?.downloadRisks.some(
          (item) => item.state === "pending",
        ),
      );
      assert.match(video.deadlineClosure!.warning, /may be destroyed/);
      assert.throws(
        () => videos.inspect(target.sessionId, "other"),
        /unavailable/,
      );
      assert.deepEqual(notifications, [
        { owner: "owner", session: target.sessionId, count: 2 },
      ]);
      await sessions.shutdown();
      recovery = videos.inspect(target.sessionId, "owner").recoveryDirectory;
    } finally {
      await sessions.shutdown();
      if (recovery) await rm(recovery, { recursive: true, force: true });
    }
  },
);
