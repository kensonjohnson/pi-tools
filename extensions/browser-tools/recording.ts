import { randomUUID } from "node:crypto";
import { rmdir, unlink } from "node:fs/promises";
import {
  createRecordingDirectory,
  recordingFile,
} from "./recording-recovery.ts";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import type { BinaryArtifactSink, DownloadArtifact } from "./downloads.ts";

export type TraceRecord = {
  id: string;
  sessionId: string;
  state:
    "starting" | "recording" | "finalizing" | "complete" | "failed" | "unknown";
  artifact?: DownloadArtifact;
  recoveryDirectory?: string;
  error?: string;
};
type Entry = {
  owner: string;
  context: BrowserContext;
  record: TraceRecord;
  directory?: string;
  start: Promise<void>;
  finish?: Promise<void>;
  settled?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

/** Native context-wide recordings contain raw sensitive information. */
export class TraceRecordings {
  private entries = new Map<string, Entry>();
  private readonly options: {
    sink: BinaryArtifactSink;
    durationMs: number;
    maxBytes: number;
    timeoutMs: number;
  };
  constructor(options: {
    sink: BinaryArtifactSink;
    durationMs: number;
    maxBytes: number;
    timeoutMs: number;
  }) {
    this.options = options;
  }

  private entry(sessionId: string, owner: string): Entry {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.owner !== owner)
      throw new Error("Recording unavailable for this owner and session.");
    return entry;
  }
  inspect(sessionId: string, owner: string): TraceRecord {
    return structuredClone(this.entry(sessionId, owner).record);
  }
  async start(
    sessionId: string,
    owner: string,
    context: BrowserContext,
  ): Promise<TraceRecord> {
    const previous = this.entries.get(sessionId);
    if (previous) {
      if (
        previous.owner !== owner ||
        !previous.settled ||
        previous.record.state !== "complete" ||
        previous.record.error
      )
        throw new Error(
          "A trace already exists for this session; stop or inspect it first.",
        );
      this.entries.delete(sessionId);
    }
    const owned = [...this.entries.entries()].filter(
      ([, item]) => item.owner === owner,
    );
    if (owned.length >= 100 || this.entries.size >= 1000) {
      const evictable = owned.find(
        ([, item]) =>
          item.settled &&
          item.record.state === "complete" &&
          !item.record.error,
      );
      if (evictable) this.entries.delete(evictable[0]);
    }
    if (
      [...this.entries.values()].filter((item) => item.owner === owner)
        .length >= 100 ||
      this.entries.size >= 1000
    )
      throw new Error(
        "Recording history capacity reached; pending recovery records are retained.",
      );
    const entry: Entry = {
      owner,
      context,
      record: { id: randomUUID(), sessionId, state: "starting" },
      start: Promise.resolve(),
    };
    this.entries.set(sessionId, entry);
    entry.start = (async () => {
      try {
        entry.directory = await createRecordingDirectory("trace", owner);
        await context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: false,
        });
        if (entry.record.state === "starting") entry.record.state = "recording";
      } catch (error) {
        entry.record.state = "failed";
        entry.record.error = `Trace start failed; native cleanup may be unverified: ${String(error).slice(0, 300)}`;
        throw error;
      }
    })();
    entry.timer = setTimeout(() => {
      void this.stop(sessionId, owner).catch(() => {});
    }, this.options.durationMs);
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entry.start,
        new Promise<never>((_, reject) => {
          startTimer = setTimeout(
            () => {
              entry.record.state = "unknown";
              entry.record.recoveryDirectory = entry.directory;
              entry.record.error =
                "Trace start deadline exceeded; native start may still be running. Stop and cleanup are unverified.";
              reject(new Error(entry.record.error));
            },
            Math.min(this.options.timeoutMs, this.options.durationMs),
          );
        }),
      ]);
    } catch (error) {
      void this.stop(sessionId, owner).catch(() => {});
      throw error;
    } finally {
      if (startTimer) clearTimeout(startTimer);
    }
    return this.inspect(sessionId, owner);
  }
  async stop(sessionId: string, owner: string): Promise<TraceRecord> {
    const entry = this.entry(sessionId, owner);
    if (!entry.finish) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.finish = this.finalize(entry);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entry.finish,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            entry.record.state = "unknown";
            entry.record.error =
              "Trace finalization deadline exceeded; native work and cleanup remain pending.";
            reject(new Error(entry.record.error));
          }, this.options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.inspect(sessionId, owner);
  }
  private async finalize(entry: Entry): Promise<void> {
    try {
      await entry.start;
      if (!entry.directory)
        throw new Error("Private recording directory unavailable.");
      const path = join(entry.directory, "trace.zip");
      entry.record.state = "finalizing";
      await entry.context.tracing.stop({ path });
      const signal = AbortSignal.timeout(this.options.timeoutMs);
      const artifact = await this.options.sink.putBinary(
        entry.owner,
        recordingFile(path),
        { maxBytes: this.options.maxBytes, signal },
      );
      entry.record.artifact = artifact;
      entry.record.state = "complete";
      entry.record.error = undefined;
    } catch (error) {
      entry.record.state = "failed";
      entry.record.error = `Trace was not published; native trace state may be unverified: ${String(error).slice(0, 300)}`;
    } finally {
      if (entry.directory) {
        if (entry.record.state === "complete") {
          try {
            await unlink(join(entry.directory, "trace.zip"));
            await rmdir(entry.directory);
          } catch {
            entry.record.recoveryDirectory = entry.directory;
            entry.record.error =
              "Private temporary cleanup unverified; directory retained for recovery.";
          }
        } else {
          entry.record.recoveryDirectory = entry.directory;
        }
      }
      entry.settled = true;
    }
  }
  async endSession(sessionId: string, owner: string): Promise<boolean> {
    if (!this.entries.has(sessionId)) return true;
    try {
      const record = await this.stop(sessionId, owner);
      return record.state === "complete" && !record.error;
    } catch {
      return false;
    }
  }
}
