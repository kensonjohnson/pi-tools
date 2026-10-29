import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { createRecordingDirectory } from "./recording-recovery.ts";
import { dirname, resolve } from "node:path";
import type { BrowserContext, Page, Video } from "playwright";
import type { BinaryArtifactSink, DownloadArtifact } from "./downloads.ts";

export type VideoRecord = {
  sessionId: string;
  state:
    | "preparing"
    | "recording"
    | "finalizing"
    | "complete"
    | "failed"
    | "unknown";
  videos: {
    id: string;
    state: "pending" | "complete" | "failed";
    artifact?: DownloadArtifact;
    error?: string;
  }[];
  recoveryDirectory?: string;
  error?: string;
};
type EbmlElement = { id: number; start: number; end: number };
function webmElement(
  data: Buffer,
  offset: number,
  parentEnd: number,
  unknownAllowed = false,
): EbmlElement {
  const width = (byte: number | undefined, maximum: number) => {
    if (!byte) throw new Error("Invalid EBML integer.");
    let marker = 0x80,
      length = 1;
    while (!(byte & marker) && length <= maximum) {
      marker >>= 1;
      length++;
    }
    if (length > maximum) throw new Error("Invalid EBML integer width.");
    return { length, marker };
  };
  const idWidth = width(data[offset], 4).length;
  if (offset + idWidth >= data.length) throw new Error("Truncated EBML ID.");
  let id = 0;
  for (let i = 0; i < idWidth; i++) id = id * 256 + data[offset + i];
  const sizeOffset = offset + idWidth;
  const sizeWidth = width(data[sizeOffset], 8);
  if (sizeOffset + sizeWidth.length > data.length)
    throw new Error("Truncated EBML size.");
  let size = BigInt(data[sizeOffset] & (sizeWidth.marker - 1));
  for (let i = 1; i < sizeWidth.length; i++)
    size = (size << 8n) | BigInt(data[sizeOffset + i]);
  const unknown = size === (1n << BigInt(sizeWidth.length * 7)) - 1n;
  const start = sizeOffset + sizeWidth.length;
  if (start > parentEnd) throw new Error("EBML header exceeds its parent.");
  if (unknown && !unknownAllowed)
    throw new Error("Unexpected unknown EBML length.");
  if (!unknown && size > BigInt(parentEnd - start))
    throw new Error("EBML element exceeds its parent.");
  return { id, start, end: unknown ? parentEnd : start + Number(size) };
}
function webmChildren(data: Buffer, start: number, end: number): EbmlElement[] {
  const entries: EbmlElement[] = [];
  for (let position = start; position < end;) {
    if (entries.length >= 4096)
      throw new Error("WebM metadata element limit exceeded.");
    const element = webmElement(data, position, end);
    if (element.end > data.length)
      throw new Error("WebM metadata exceeds bounded validation.");
    entries.push(element);
    position = element.end;
  }
  return entries;
}

/** A bounded structural check, not a decoder or a guarantee of playback. */
async function validateNativeWebm(
  file: FileHandle,
  stat: Stats,
): Promise<void> {
  {
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 32)
      throw new Error(
        "Native video is empty, truncated, or changed; it was not published.",
      );
    const data = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    let bytesRead = 0;
    while (bytesRead < data.length) {
      const result = await file.read(
        data,
        bytesRead,
        data.length - bytesRead,
        bytesRead,
      );
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    const bytes = data.subarray(0, bytesRead);
    try {
      const header = webmElement(bytes, 0, stat.size);
      if (header.id !== 0x1a45dfa3 || header.end > bytes.length)
        throw new Error("Invalid WebM header.");
      const doctype = webmChildren(bytes, header.start, header.end).find(
        (item) => item.id === 0x4282,
      );
      if (
        !doctype ||
        bytes.subarray(doctype.start, doctype.end).toString("ascii") !== "webm"
      )
        throw new Error("Invalid WebM document type.");
      const segment = webmElement(bytes, header.end, stat.size, true);
      if (segment.id !== 0x18538067) throw new Error("Missing WebM segment.");
      let position = segment.start,
        videoTrack = false,
        cluster = false,
        segmentElements = 0;
      while (position < segment.end && position < bytes.length) {
        if (++segmentElements > 4096)
          throw new Error("WebM segment element limit exceeded.");
        const element = webmElement(bytes, position, segment.end, true);
        if (element.id === 0x1654ae6b) {
          for (const track of webmChildren(
            bytes,
            element.start,
            element.end,
          ).filter((item) => item.id === 0xae)) {
            const fields = webmChildren(bytes, track.start, track.end);
            const type = fields.find((item) => item.id === 0x83);
            const codec = fields.find((item) => item.id === 0x86);
            if (
              type &&
              type.end - type.start === 1 &&
              bytes[type.start] === 1 &&
              codec &&
              ["V_VP8", "V_VP9"].includes(
                bytes.subarray(codec.start, codec.end).toString("ascii"),
              )
            )
              videoTrack = true;
          }
        }
        if (
          element.id === 0x1f43b675 &&
          element.end > element.start &&
          element.start < bytes.length
        ) {
          let childPosition = element.start,
            clusterElements = 0;
          while (childPosition < element.end && childPosition < bytes.length) {
            if (++clusterElements > 4096)
              throw new Error("WebM cluster element limit exceeded.");
            const child = webmElement(bytes, childPosition, element.end);
            if (
              (child.id === 0xa3 || child.id === 0xa0) &&
              child.end - child.start >= 4 &&
              child.start < bytes.length
            ) {
              cluster = true;
              break;
            }
            if (child.end <= childPosition || child.end > bytes.length) break;
            childPosition = child.end;
          }
          break;
        }
        if (element.end <= position || element.end > bytes.length) break;
        position = element.end;
      }
      if (!videoTrack || !cluster)
        throw new Error("Missing video track or cluster.");
    } catch (error) {
      throw new Error(
        "Native video failed bounded WebM structure checks; it was not published.",
        { cause: error },
      );
    }
  }
}

function sameVideo(before: Stats, after: Stats): boolean {
  return (
    after.isFile() &&
    after.nlink === 1 &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

/** Stream the already validated inode; the sink must exhaust the iterator before committing. */
async function* videoBytes(
  file: FileHandle,
  original: Stats,
  finished: { value: boolean },
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  while (offset < original.size) {
    const chunk = Buffer.allocUnsafe(
      Math.min(64 * 1024, original.size - offset),
    );
    const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
    if (!bytesRead) throw new Error("Native video changed during publication.");
    offset += bytesRead;
    yield chunk.subarray(0, bytesRead);
  }
  if (!sameVideo(original, await file.stat()))
    throw new Error("Native video changed during publication.");
  finished.value = true;
}

type Entry = {
  owner: string;
  directory: string;
  record: VideoRecord;
  native: { id: string; video: Video }[];
  pages: Set<Page>;
  context?: BrowserContext;
  listener?: (page: Page) => void;
  timer?: ReturnType<typeof setTimeout>;
  finish?: Promise<void>;
  overflow: boolean;
};

/** Native video records every page in a newly created owned context. */
export class VideoRecordings {
  private entries = new Map<string, Entry>();
  private readonly options: {
    sink: BinaryArtifactSink;
    durationMs: number;
    timeoutMs: number;
    maxBytes: number;
  };
  constructor(options: {
    sink: BinaryArtifactSink;
    durationMs: number;
    timeoutMs: number;
    maxBytes: number;
  }) {
    this.options = options;
  }
  private entry(sessionId: string, owner: string): Entry {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.owner !== owner)
      throw new Error(
        "Video recording unavailable for this owner and session.",
      );
    return entry;
  }
  inspect(sessionId: string, owner: string): VideoRecord {
    return structuredClone(this.entry(sessionId, owner).record);
  }
  async prepare(sessionId: string, owner: string): Promise<string> {
    if (this.entries.has(sessionId))
      throw new Error("Duplicate video session.");
    const owned = [...this.entries.entries()].filter(
      ([, item]) => item.owner === owner,
    );
    if (owned.length >= 100 || this.entries.size >= 1000) {
      const evictable = owned.find(
        ([, item]) => item.record.state === "complete",
      );
      if (evictable) this.entries.delete(evictable[0]);
    }
    if (
      this.entries.size >= 1000 ||
      [...this.entries.values()].filter((item) => item.owner === owner)
        .length >= 100
    )
      throw new Error(
        "Video recording history capacity reached; pending recovery records are retained.",
      );
    // Reserve before filesystem work, so concurrent starts cannot bypass admission.
    const entry: Entry = {
      owner,
      directory: "",
      record: { sessionId, state: "preparing", videos: [] },
      native: [],
      pages: new Set(),
      overflow: false,
    };
    this.entries.set(sessionId, entry);
    try {
      entry.directory = await createRecordingDirectory("video", owner);
      return entry.directory;
    } catch (error) {
      this.entries.delete(sessionId);
      throw error;
    }
  }
  attach(
    sessionId: string,
    owner: string,
    context: BrowserContext,
    onDeadline: () => void,
  ): void {
    const entry = this.entry(sessionId, owner);
    const capture = (page: Page) => {
      if (entry.pages.has(page) || entry.overflow) return;
      if (entry.native.length >= 100) {
        entry.overflow = true;
        entry.record.error =
          "Video page limit exceeded; the private directory is retained for recovery.";
        onDeadline();
        return;
      }
      entry.pages.add(page);
      const video = page.video();
      if (!video) {
        entry.overflow = true;
        entry.record.error =
          "Native page video unavailable; private directory retained.";
        onDeadline();
        return;
      }
      const id = randomUUID();
      entry.native.push({ id, video });
      entry.record.videos.push({ id, state: "pending" });
    };
    entry.context = context;
    entry.listener = capture;
    context.on("page", capture);
    for (const page of context.pages()) capture(page);
    entry.record.state = "recording";
    if (!entry.overflow)
      entry.timer = setTimeout(onDeadline, this.options.durationMs);
  }
  /** Called only after confirmed owned context/browser closure. */
  async closed(sessionId: string, owner: string): Promise<boolean> {
    const entry = this.entry(sessionId, owner);
    if (!entry.context) {
      this.markUnverified(
        sessionId,
        owner,
        "Context setup did not complete; private directory retained for recovery.",
      );
      return false;
    }
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
            entry.record.recoveryDirectory = entry.directory;
            entry.record.error =
              "Video finalization deadline exceeded; work may still be running.";
            reject(new Error(entry.record.error));
          }, this.options.timeoutMs);
        }),
      ]);
      return entry.record.state === "complete";
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  markUnverified(sessionId: string, owner: string, message: string): void {
    const entry = this.entry(sessionId, owner);
    if (entry.timer) clearTimeout(entry.timer);
    entry.record.state = "unknown";
    entry.record.recoveryDirectory = entry.directory;
    entry.record.error = message;
  }
  private async finalize(entry: Entry): Promise<void> {
    entry.record.state = "finalizing";
    if (entry.context && entry.listener) {
      try {
        entry.context.off("page", entry.listener);
      } catch {
        entry.overflow = true;
      }
    }
    const savedPaths: { path: string; identity: Stats }[] = [];
    for (const native of entry.native) {
      const record = entry.record.videos.find((item) => item.id === native.id)!;
      try {
        const path = resolve(await native.video.path());
        if (dirname(path) !== resolve(entry.directory))
          throw new Error(
            "Native video path is outside its private directory.",
          );
        const expected = await lstat(path);
        if (
          !expected.isFile() ||
          expected.isSymbolicLink() ||
          expected.nlink !== 1
        )
          throw new Error("Unsafe native video file.");
        const file = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const identity = await file.stat();
          if (!sameVideo(expected, identity))
            throw new Error("Native video changed before validation.");
          await validateNativeWebm(file, identity);
          const finished = { value: false };
          record.artifact = await this.options.sink.putBinary(
            entry.owner,
            videoBytes(file, identity, finished),
            {
              maxBytes: this.options.maxBytes,
              signal: AbortSignal.timeout(this.options.timeoutMs),
            },
          );
          if (!finished.value)
            throw new Error(
              "Video sink did not consume and verify the complete file; publication is unverified.",
            );
          record.state = "complete";
          savedPaths.push({ path, identity });
        } finally {
          await file.close();
        }
      } catch (error) {
        record.state = "failed";
        record.error = String(error).slice(0, 300);
        entry.overflow = true;
      }
    }
    if (!entry.overflow) {
      try {
        for (const { path, identity } of savedPaths) {
          const current = await lstat(path);
          if (current.isSymbolicLink() || !sameVideo(identity, current))
            throw new Error("Native video path changed; refusing cleanup.");
          await unlink(path);
        }
        await rmdir(entry.directory);
      } catch {
        entry.overflow = true;
      }
    }
    if (entry.overflow) {
      entry.record.state = "failed";
      entry.record.recoveryDirectory = entry.directory;
      entry.record.error ??=
        "Video publication or private temporary cleanup failed; directory retained for recovery.";
    } else {
      entry.record.state = "complete";
      entry.record.recoveryDirectory = undefined;
      entry.record.error = undefined;
    }
  }
}
