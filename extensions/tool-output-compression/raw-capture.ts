import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type RawOutputSource = "visible" | "full-output-path";

export type CapturedRawOutput = {
  content: string;
  source: RawOutputSource;
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
