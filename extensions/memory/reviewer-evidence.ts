import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type FileEvidence = {
  id: string;
  path: string;
  text: string;
  sha256: string;
};
type Snapshot = FileEvidence & { dev: number; ino: number };
export type EvidenceLimits = {
  maxCalls?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
};

/** Bounded read-only evidence. Receipts are created and retained by the host. */
export class RepositoryEvidence {
  private readonly root: string;
  private readonly limits: Required<EvidenceLimits>;
  private calls = 0;
  private bytes = 0;
  private readonly receipts = new Map<string, Snapshot>();
  constructor(root: string, limits: EvidenceLimits = {}) {
    this.root = resolve(root);
    this.limits = {
      maxCalls: limits.maxCalls ?? 16,
      maxFileBytes: limits.maxFileBytes ?? 64 * 1024,
      maxTotalBytes: limits.maxTotalBytes ?? 256 * 1024,
    };
    if (
      Object.values(this.limits).some((n) => !Number.isSafeInteger(n) || n < 1)
    )
      throw new Error("invalid evidence limits");
  }
  private async snapshot(path: string): Promise<Omit<Snapshot, "id">> {
    if (
      !path ||
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((p) => !p || p === "." || p === "..")
    )
      throw new Error("invalid project-relative evidence path");
    if (
      path
        .split("/")
        .some(
          (part) =>
            part.startsWith(".") ||
            /^(?:credentials?|secrets?|auth)(?:\.|$)/i.test(part) ||
            /\.(?:pem|key|p12|pfx|kdbx)$/i.test(part),
        )
    )
      throw new Error("private or hidden evidence path is excluded");
    const root = await realpath(this.root);
    let current = root;
    for (const part of path.split("/")) {
      current = resolve(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error("symlink evidence is unsupported");
    }
    const resolved = await realpath(current);
    const rel = relative(root, resolved);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("evidence escapes project root");
    const file = await open(
      resolved,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > this.limits.maxFileBytes)
        throw new Error("evidence is not a bounded regular file");
      const data = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(
          data,
          offset,
          data.length - offset,
          offset,
        );
        if (!bytesRead) throw new Error("evidence truncated during read");
        offset += bytesRead;
      }
      const after = await file.stat();
      const live = await stat(current);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        live.dev !== after.dev ||
        live.ino !== after.ino ||
        (await realpath(current)) !== resolved
      )
        throw new Error("evidence changed during read");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (text.includes("\0"))
        throw new Error("binary evidence is unsupported");
      return {
        path,
        text,
        sha256: createHash("sha256").update(data).digest("hex"),
        dev: before.dev,
        ino: before.ino,
      };
    } finally {
      await file.close();
    }
  }
  async read(path: string): Promise<FileEvidence> {
    if (++this.calls > this.limits.maxCalls)
      throw new Error("evidence call limit reached");
    const snapshot = await this.snapshot(path);
    const size = Buffer.byteLength(snapshot.text);
    if (this.bytes + size > this.limits.maxTotalBytes)
      throw new Error("evidence byte limit reached");
    this.bytes += size;
    const id = randomUUID();
    this.receipts.set(id, { ...snapshot, id });
    return {
      id,
      path: snapshot.path,
      text: snapshot.text,
      sha256: snapshot.sha256,
    };
  }
  async verify(id: string, quote: string): Promise<FileEvidence> {
    const receipt = this.receipts.get(id);
    if (
      !receipt ||
      typeof quote !== "string" ||
      !quote ||
      !receipt.text.includes(quote)
    )
      throw new Error("unknown evidence receipt or quote");
    return this.revalidate(id);
  }
  async revalidate(id: string): Promise<FileEvidence> {
    const receipt = this.receipts.get(id);
    if (!receipt) throw new Error("unknown evidence receipt");
    const current = await this.snapshot(receipt.path);
    if (
      current.dev !== receipt.dev ||
      current.ino !== receipt.ino ||
      current.sha256 !== receipt.sha256
    )
      throw new Error("evidence changed since review");
    return {
      id,
      path: receipt.path,
      text: receipt.text,
      sha256: receipt.sha256,
    };
  }
}
