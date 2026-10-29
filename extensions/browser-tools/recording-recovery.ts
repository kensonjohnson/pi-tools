import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, opendir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RECORDING_RECOVERY_SCAN_LIMIT = 10000;
const ownerKey = (owner: string) =>
  createHash("sha256").update(owner).digest("hex");
const prefix = (kind: "trace" | "video", owner: string) =>
  `pi-browser-${kind}-${ownerKey(owner)}-`;

/** The native writer uses a 0700 directory in the OS temporary directory. */
export async function createRecordingDirectory(
  kind: "trace" | "video",
  owner: string,
): Promise<string> {
  const root = await realpath(tmpdir());
  return mkdtemp(join(root, prefix(kind, owner)));
}

/** The stream does not open until the sink requests its first chunk. */
export async function* recordingFile(path: string): AsyncGenerator<Uint8Array> {
  const stream = createReadStream(path);
  try {
    for await (const chunk of stream) yield chunk as Buffer;
  } finally {
    stream.destroy();
  }
}

/** Read-only discovery. A matching directory may still be live; never delete it here. */
export async function listRecordingRecovery(
  owner: string,
  offset = 0,
  limit = 20,
) {
  const root = await realpath(tmpdir());
  const directory = await opendir(root);
  const prefixes = [prefix("trace", owner), prefix("video", owner)];
  const items: { kind: "trace" | "video"; path: string; modifiedAt: number }[] =
    [];
  let scanned = 0,
    matches = 0,
    unsafe = 0,
    truncated = false,
    more = false;
  for await (const item of directory) {
    if (++scanned > RECORDING_RECOVERY_SCAN_LIMIT) {
      truncated = true;
      break;
    }
    const kindIndex = prefixes.findIndex((value) =>
      item.name.startsWith(value),
    );
    if (kindIndex < 0) continue;
    const suffix = item.name.slice(prefixes[kindIndex].length);
    if (!/^[A-Za-z0-9]{6}$/.test(suffix)) {
      unsafe++;
      continue;
    }
    const path = join(root, item.name);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    ) {
      unsafe++;
      continue;
    }
    if (matches++ < offset) continue;
    if (items.length >= limit) {
      more = true;
      break;
    }
    items.push({
      kind: kindIndex === 0 ? "trace" : "video",
      path,
      modifiedAt: stat.mtimeMs,
    });
  }
  return {
    root,
    items,
    nextOffset: more ? offset + items.length : null,
    scanned,
    scanLimit: RECORDING_RECOVERY_SCAN_LIMIT,
    truncated,
    unsafeEntries: unsafe,
    notice:
      "Read-only discovery, not proof of an orphan. A browser or native finalization may still be using these directories. Do not delete until ownership and process exit are verified. Other Pi owners and older unscoped pi-browser-trace-* and pi-browser-video-* directories require manual local inspection of the OS temporary directory. Native transient bytes are not quota-limited.",
  };
}
