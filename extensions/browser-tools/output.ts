import type { ArtifactStore } from "./artifacts.ts";

const INLINE_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 48 * 1024;
const size = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

/** Results always label scope and representation; details never duplicate content. */
export async function inspectionOutput(
  store: ArtifactStore,
  owner: string,
  text: string,
  metadata: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("Artifact operation cancelled.");
  if (!text.isWellFormed())
    throw new Error(
      "Result contains unpaired UTF-16 surrogates and cannot be represented losslessly as UTF-8.",
    );
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= INLINE_LIMIT) {
    const inline = {
      ...metadata,
      encoding: "utf-8",
      bytes,
      complete: true,
      text,
    };
    if (size(inline) <= INLINE_LIMIT) return JSON.stringify(inline);
  }
  if (bytes > store.quota)
    throw new Error("Artifact quota exceeded; full result was not saved.");
  const artifact = await store.put(owner, text, signal);
  const data = Buffer.alloc(2048);
  const end = data.write(text, "utf8");
  const preview = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(data.subarray(0, end));
  return JSON.stringify({
    ...metadata,
    encoding: "utf-8",
    bytes,
    complete: false,
    preview,
    previewBytes: end,
    notice: artifact.lockWarning
      ? "Preview only; the complete artifact was saved, but lock cleanup failed. Inspect the lock before retrieving it."
      : "Preview only; read the artifact to retrieve the complete result.",
    artifact,
  });
}

/** Binary offsets and chunk sizes are raw bytes. Base64 payloads remain under the response limit. */
export async function binaryChunkOutput(
  store: ArtifactStore,
  owner: string,
  id: string,
  offset: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const chunk = await store.readBinary(owner, id, offset, maxBytes, signal);
  const output = JSON.stringify({
    ...chunk,
    complete: chunk.nextOffset === null,
  });
  if (size(JSON.parse(output)) > RESPONSE_LIMIT)
    throw new Error("Artifact chunk metadata exceeded response limit.");
  return output;
}

/** Bound the entire JSON response, including escaping and metadata, not just payload bytes. */
export async function chunkOutput(
  store: ArtifactStore,
  owner: string,
  id: string,
  offset: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const chunk = await store.read(owner, id, offset, maxBytes, signal);
  const original = Buffer.from(chunk.text, "utf8");
  let length = original.length;
  for (;;) {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(original.subarray(0, length));
    const next = offset + length;
    const value = {
      ...chunk,
      text,
      chunkBytes: length,
      nextOffset: next < chunk.bytes ? next : null,
      complete: next === chunk.bytes,
    };
    if (size(value) <= RESPONSE_LIMIT) return JSON.stringify(value);
    if (length <= 4)
      throw new Error("Artifact chunk metadata exceeded response limit.");
    length = Math.max(4, Math.floor(length * 0.7));
    while (length < original.length && (original[length] & 0xc0) === 0x80)
      length--;
  }
}
