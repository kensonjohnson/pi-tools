import { constants } from "node:fs";
import { mkdtemp, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Copy from opened regular files into a private staging directory without buffering whole files. */
export async function stageUploadFiles(
  paths: string[],
  cwd: string,
  limits: { maxFileBytes: number; maxTotalBytes: number },
  deadline: number,
  signal?: AbortSignal,
  onRoot?: (path: string) => void,
) {
  let root: string;
  try {
    root = await mkdtemp(join(tmpdir(), "pi-browser-upload-"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOSPC" || code === "EDQUOT")
      throw new Error("Insufficient staging disk space or disk quota.", {
        cause: error,
      });
    throw error;
  }
  const files: string[] = [];
  let total = 0;
  const check = () => {
    if (signal?.aborted || Date.now() >= deadline)
      throw new Error("Upload cancelled or deadline exceeded before dispatch.");
  };
  try {
    onRoot?.(root);
    for (const [index, path] of paths.entries()) {
      check();
      if (!path || path.length > 4096 || /[\u0000*?\[\]]/.test(path))
        throw new Error(`Invalid explicit upload path at index ${index}.`);
      const name = basename(path);
      if (!name || Buffer.byteLength(name) > 255)
        throw new Error("Invalid filename.");
      let source: Awaited<ReturnType<typeof open>> | undefined;
      let output: Awaited<ReturnType<typeof open>> | undefined;
      try {
        source = await open(
          resolve(cwd, path),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const stat = await source.stat();
        if (
          !stat.isFile() ||
          !Number.isSafeInteger(stat.size) ||
          stat.size > limits.maxFileBytes ||
          stat.size > limits.maxTotalBytes - total
        )
          throw new Error(
            "File is not a regular file or exceeds upload limits.",
          );
        const dir = join(root, String(index));
        await mkdir(dir);
        const destination = join(dir, name);
        output = await open(destination, "wx", 0o600);
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let offset = 0;
        while (offset < stat.size) {
          check();
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.length, stat.size - offset),
            offset,
          );
          if (!bytesRead) throw new Error("File changed during read.");
          let written = 0;
          while (written < bytesRead) {
            check();
            const result = await output.write(
              buffer,
              written,
              bytesRead - written,
            );
            if (!result.bytesWritten)
              throw new Error("Upload staging write failed.");
            written += result.bytesWritten;
          }
          offset += bytesRead;
        }
        check();
        const after = await source.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
          throw new Error("File changed during read.");
        total += stat.size;
        files.push(destination);
      } catch (error) {
        const detail =
          (error as NodeJS.ErrnoException)?.code === "ENOSPC" ||
          (error as NodeJS.ErrnoException)?.code === "EDQUOT"
            ? "Insufficient staging disk space or disk quota."
            : error instanceof Error
              ? error.message
              : String(error);
        throw new Error(
          `Upload file ${index + 1} could not be read or staged: ${detail}`,
          { cause: error },
        );
      } finally {
        await output?.close();
        await source?.close();
      }
    }
    return {
      files,
      total,
      root,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (cleanupError) {
      throw Object.assign(
        new Error(
          `Upload staging failed and cleanup failed; private staging remains at ${root}: ${String(cleanupError)}. Original error: ${String(error)}`,
          { cause: error },
        ),
        { uploadCleanupFailed: true },
      );
    }
    throw error;
  }
}
