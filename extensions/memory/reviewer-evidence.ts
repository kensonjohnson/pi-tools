import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat, opendir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type FileEvidence = {
  id: string;
  path: string;
  text: string;
  sha256: string;
};
type Snapshot = FileEvidence & {
  dev: number;
  ino: number;
  query?: string;
  missing?: boolean;
};
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
  private async snapshot(
    path: string,
    query?: string,
    missing = false,
  ): Promise<Omit<Snapshot, "id">> {
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
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      current = resolve(current, parts[i]);
      let info;
      try {
        info = await lstat(current);
      } catch (error: any) {
        if (missing && error?.code === "ENOENT") {
          const text = `Project-relative path does not exist: ${path}`;
          return {
            path,
            text,
            sha256: createHash("sha256").update(text).digest("hex"),
            dev: 0,
            ino: 0,
            missing: true,
          };
        }
        throw error;
      }
      if (info.isSymbolicLink())
        throw new Error("symlink evidence is unsupported");
    }
    if (missing) throw new Error("requested missing path exists");
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
      if (
        !before.isFile() ||
        before.size > (query ? 1024 * 1024 : this.limits.maxFileBytes)
      )
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
      const fullText = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (fullText.includes("\0"))
        throw new Error("binary evidence is unsupported");
      let text = fullText;
      if (query) {
        const paragraphs = fullText.split(/\r?\n[\t ]*\r?\n/);
        const paragraph = paragraphs.find((p) =>
          p.toLowerCase().includes(query.toLowerCase()),
        );
        if (!paragraph) throw new Error("no matching paragraph");
        if (Buffer.byteLength(paragraph) > this.limits.maxFileBytes)
          throw new Error("matching paragraph exceeds excerpt limit");
        text = paragraph.trim();
      }
      return {
        path,
        text,
        sha256: createHash("sha256").update(data).digest("hex"),
        dev: before.dev,
        ino: before.ino,
        ...(query ? { query } : {}),
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
  async excerpt(path: string, query: string): Promise<FileEvidence> {
    if (!query.trim() || query.length > 200)
      throw new Error("invalid evidence query");
    return this.capture(path, query);
  }
  async missing(path: string): Promise<FileEvidence> {
    return this.capture(path, undefined, true);
  }
  private async capture(
    path: string,
    query?: string,
    missing = false,
  ): Promise<FileEvidence> {
    if (++this.calls > this.limits.maxCalls)
      throw new Error("evidence call limit reached");
    const snapshot = await this.snapshot(path, query, missing);
    const size = Buffer.byteLength(snapshot.text);
    if (this.bytes + size > this.limits.maxTotalBytes)
      throw new Error("evidence byte limit reached");
    this.bytes += size;
    const id = randomUUID();
    this.receipts.set(id, { ...snapshot, id });
    return { id, path, text: snapshot.text, sha256: snapshot.sha256 };
  }
  /** Bounded public-path inventory; never follows links or descends dependency trees. */
  async discover(): Promise<{ paths: string[]; truncated: boolean }> {
    const root = await realpath(this.root);
    const paths: string[] = [],
      queue = [""];
    let examined = 0,
      pathBytes = 0,
      truncated = false;
    while (queue.length) {
      const dir = queue.shift()!;
      const directory = resolve(root, dir);
      const before = await lstat(directory);
      if (before.isSymbolicLink() || !before.isDirectory()) {
        truncated = true;
        continue;
      }
      const resolved = await realpath(directory);
      const rel = relative(root, resolved);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        truncated = true;
        continue;
      }
      const entries: import("node:fs").Dirent[] = [];
      const handle = await opendir(directory);
      for await (const entry of handle) {
        entries.push(entry);
        if (entries.length > 5000 - examined) break;
      }
      const after = await lstat(directory);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        after.isSymbolicLink()
      ) {
        truncated = true;
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++examined > 5000 || paths.length >= 1000) {
          truncated = true;
          break;
        }
        if (
          entry.name.startsWith(".") ||
          /^(?:node_modules|vendor|dist|build|tmp|credentials?|secrets?|auth)(?:\.|$)/i.test(
            entry.name,
          ) ||
          /\.(?:pem|key|p12|pfx|kdbx)$/i.test(entry.name)
        )
          continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        const bytes = Buffer.byteLength(path) + 4;
        if (path.length > 512 || pathBytes + bytes > 32 * 1024) {
          truncated = true;
          break;
        }
        pathBytes += bytes;
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile()) paths.push(path);
      }
      if (truncated) break;
    }
    return { paths, truncated };
  }
  /** Search a bounded inventory; each match is a revalidated paragraph receipt. */
  async search(
    paths: string[],
    query: string,
  ): Promise<{ files: FileEvidence[]; examined: number; incomplete: boolean }> {
    if (!query.trim() || query.length > 200)
      throw new Error("invalid evidence query");
    const files: FileEvidence[] = [];
    let examined = 0,
      incomplete = paths.length === 0;
    for (const path of paths) {
      if (examined >= 100 || files.length >= 4) {
        incomplete = true;
        break;
      }
      examined++;
      try {
        const match = await this.snapshot(path, query);
        const id = randomUUID();
        const size = Buffer.byteLength(match.text);
        if (
          ++this.calls > this.limits.maxCalls ||
          this.bytes + size > this.limits.maxTotalBytes
        ) {
          incomplete = true;
          break;
        }
        this.bytes += size;
        this.receipts.set(id, { ...match, id });
        files.push({ id, path, text: match.text, sha256: match.sha256 });
      } catch (error: any) {
        if (error?.message !== "no matching paragraph") incomplete = true;
      }
    }
    return { files, examined, incomplete };
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
    const current = await this.snapshot(
      receipt.path,
      receipt.query,
      receipt.missing,
    );
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
