import { lstat, open, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type RawOutputSource = "visible" | "full-output-path";

export type CapturedRawOutput = {
  content: string;
  source: RawOutputSource;
};

/** Bounded binary evidence for deciding whether full raw capture is worthwhile. */
export type RawOutputProbe = {
  byteLength: number;
  head: Buffer;
  tail: Buffer;
};

export class RawOutputCaptureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RawOutputCaptureError";
  }
}

/**
 * Reads Pi's successful bash full-output artifact when available. The artifact
 * is deliberately only held in memory here; callers decide whether apply mode
 * may persist it to the private SQLite store.
 */
export async function captureBashRawOutput(
  details: unknown,
  visibleContent: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<CapturedRawOutput> {
  throwIfAborted(signal);
  const fullOutputPath = getFullOutputPath(details);
  if (!fullOutputPath) return { content: visibleContent, source: "visible" };

  try {
    const file = await lstat(fullOutputPath);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new RawOutputCaptureError("Pi full output is not a regular file.");
    }
    if (file.size > maxBytes) {
      throw new RawOutputCaptureError(
        `Pi full output is ${file.size} bytes, above the configured per-output limit.`,
      );
    }

    const bytes = await readFile(fullOutputPath, { signal });
    throwIfAborted(signal);
    if (bytes.byteLength > maxBytes) {
      throw new RawOutputCaptureError(
        `Pi full output is ${bytes.byteLength} bytes, above the configured per-output limit.`,
      );
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { content, source: "full-output-path" };
  } catch (error) {
    if (error instanceof RawOutputCaptureError) throw error;
    if (signal?.aborted) {
      throw new RawOutputCaptureError("Pi full-output capture was cancelled.", {
        cause: error,
      });
    }
    throw new RawOutputCaptureError("Could not read Pi full output.", {
      cause: error,
    });
  }
}

/**
 * Reads only the beginning and end of Pi's full-output artifact. Probe bytes
 * remain binary so an arbitrary chunk boundary can never introduce malformed
 * UTF-8 into a later parser decision.
 */
export async function probeBashRawOutput(
  details: unknown,
  maxBytes: number,
  probeBytes: number,
  signal?: AbortSignal,
): Promise<RawOutputProbe | undefined> {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(probeBytes) || probeBytes <= 0) {
    throw new RawOutputCaptureError("Raw-output probe size is invalid.");
  }
  const fullOutputPath = getFullOutputPath(details);
  if (!fullOutputPath) return undefined;

  try {
    const file = await lstat(fullOutputPath);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new RawOutputCaptureError("Pi full output is not a regular file.");
    }
    if (file.size > maxBytes) {
      throw new RawOutputCaptureError(
        `Pi full output is ${file.size} bytes, above the configured per-output limit.`,
      );
    }

    const handle = await open(fullOutputPath, "r");
    try {
      const length = Math.min(probeBytes, file.size);
      const head = Buffer.alloc(length);
      const tail = Buffer.alloc(length);
      const [headResult, tailResult] = await Promise.all([
        handle.read(head, 0, length, 0),
        handle.read(tail, 0, length, Math.max(0, file.size - length)),
      ]);
      throwIfAborted(signal);
      return {
        byteLength: file.size,
        head: head.subarray(0, headResult.bytesRead),
        tail: tail.subarray(0, tailResult.bytesRead),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof RawOutputCaptureError) throw error;
    if (signal?.aborted) {
      throw new RawOutputCaptureError("Pi full-output probe was cancelled.", {
        cause: error,
      });
    }
    throw new RawOutputCaptureError("Could not probe Pi full output.", {
      cause: error,
    });
  }
}

function getFullOutputPath(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as { fullOutputPath?: unknown }).fullOutputPath;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isAbsolute(value) || value.length === 0) {
    throw new RawOutputCaptureError("Pi full-output path is invalid.");
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RawOutputCaptureError("Pi full-output capture was cancelled.");
  }
}
