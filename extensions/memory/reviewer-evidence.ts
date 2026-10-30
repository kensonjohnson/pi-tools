import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat, opendir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type FileEvidence = {
  id: string;
  path: string;
  text: string;
  sha256: string;
  /** Byte offset for the next UTF-8 chunk, when this evidence is partial. */
  nextOffset?: number;
  /** Excerpt offsets refer to UTF-8 bytes in the original file. */
  excerpt?: {
    paragraphStart: number;
    paragraphEnd: number;
    windowStart: number;
    windowEnd: number;
    omittedBefore: boolean;
    omittedAfter: boolean;
  };
};

/** Locate the first matching paragraph without retaining its contents. */
class ParagraphScanner {
  private readonly needle: string;
  private readonly prefix: number[];
  private readonly offsets: number[] = [];
  private matched = 0;
  private units = 0;
  private pos = 0;
  private start = 0;
  private candidate: number | undefined;
  private state = 0;
  private previousCR: number | undefined;
  private match: { start: number; end: number } | undefined;
  result: { start: number; end: number; matchStart: number } | undefined;
  constructor(query: string) {
    this.needle = query.toLowerCase().replace(/ς/g, "σ");
    this.prefix = Array(this.needle.length).fill(0);
    for (let i = 1, n = 0; i < this.needle.length; i++) {
      while (n && this.needle[i] !== this.needle[n]) n = this.prefix[n - 1];
      if (this.needle[i] === this.needle[n]) n++;
      this.prefix[i] = n;
    }
  }
  push(text: string): void {
    for (const char of text) {
      const at = this.pos;
      this.pos += Buffer.byteLength(char);
      if (this.result) continue;
      if (!this.match) {
        for (const unit of char.toLowerCase().replace(/ς/g, "σ").split("")) {
          this.offsets[this.units % this.needle.length] = at;
          this.units++;
          while (this.matched && unit !== this.needle[this.matched])
            this.matched = this.prefix[this.matched - 1];
          if (unit === this.needle[this.matched]) this.matched++;
          if (this.matched === this.needle.length) {
            this.match = {
              start:
                this.offsets[
                  (this.units - this.needle.length) % this.needle.length
                ],
              end: this.pos,
            };
            break;
          }
        }
      }
      if (this.state === 1 && (char === " " || char === "\t")) {
        /* blank-line whitespace */
      } else if (this.state === 1 && char === "\r") this.state = 2;
      else if ((this.state === 1 || this.state === 2) && char === "\n") {
        const boundary = this.candidate!;
        if (this.match && this.match.end <= boundary)
          this.result = {
            start: this.start,
            end: boundary,
            matchStart: this.match.start,
          };
        this.start = this.pos;
        this.match = undefined;
        this.matched = 0;
        this.units = 0;
        this.state = 0;
        this.candidate = undefined;
      } else if (char === "\n") {
        this.candidate = this.previousCR ?? at;
        this.state = 1;
      } else {
        this.state = 0;
        this.candidate = undefined;
      }
      this.previousCR = char === "\r" ? at : undefined;
    }
  }
  finish(): { start: number; end: number; matchStart: number } | undefined {
    return (
      this.result ??
      (this.match
        ? { start: this.start, end: this.pos, matchStart: this.match.start }
        : undefined)
    );
  }
}
type Snapshot = FileEvidence & {
  dev: number;
  ino: number;
  query?: string;
  missing?: boolean;
  page?: { offset: number; maxBytes: number };
};
export type EvidenceLimits = {
  maxCalls?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
};

/** Bounded read-only evidence. Receipts are created and retained by the host. */
export class RepositoryEvidence {
  private readonly root: string;
  private readonly limits: EvidenceLimits;
  private calls = 0;
  private bytes = 0;
  private readonly receipts = new Map<string, Snapshot>();
  constructor(root: string, limits: EvidenceLimits = {}) {
    this.root = resolve(root);
    this.limits = { ...limits };
    if (
      Object.values(this.limits).some((n) => !Number.isSafeInteger(n) || n < 1)
    )
      throw new Error("invalid evidence limits");
  }
  private async snapshot(
    path: string,
    query?: string,
    missing = false,
    page?: { offset: number; maxBytes: number },
    excerptMaxBytes?: number,
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
        (this.limits.maxFileBytes !== undefined &&
          !query &&
          before.size > this.limits.maxFileBytes)
      )
        throw new Error("evidence is not a bounded regular file");
      const hash = createHash("sha256");
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      });
      const chunks: Buffer[] = [];
      const scanner = query ? new ParagraphScanner(query) : undefined;
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      const start = page?.offset ?? 0;
      const end = page
        ? Math.min(before.size, start + page.maxBytes)
        : before.size;
      if (start > before.size) throw new Error("invalid evidence offset");
      while (offset < before.size) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - offset),
          offset,
        );
        if (!bytesRead) throw new Error("evidence truncated during read");
        const data = buffer.subarray(0, bytesRead);
        hash.update(data);
        const decoded = decoder.decode(data, { stream: true });
        if (decoded.includes("\0"))
          throw new Error("binary evidence is unsupported");
        scanner?.push(decoded);
        const from = Math.max(start, offset),
          to = Math.min(end, offset + bytesRead);
        if (!query && to > from)
          chunks.push(Buffer.from(data.subarray(from - offset, to - offset)));
        offset += bytesRead;
      }
      const finalText = decoder.decode();
      if (finalText.includes("\0"))
        throw new Error("binary evidence is unsupported");
      scanner?.push(finalText);
      const paragraph = scanner?.finish();
      const digest = hash.digest("hex");
      let excerptInfo: FileEvidence["excerpt"];
      let selectedPage = page;
      if (paragraph) {
        const maxBytes = page?.maxBytes ?? excerptMaxBytes ?? 256 * 1024;
        const windowStart =
          page?.offset ??
          (paragraph.matchStart - paragraph.start < maxBytes / 2
            ? paragraph.start
            : paragraph.matchStart);
        if (windowStart < paragraph.start || windowStart > paragraph.end)
          throw new Error("invalid evidence offset");
        const windowEnd = Math.min(paragraph.end, windowStart + maxBytes);
        const secondHash = createHash("sha256");
        let position = 0;
        while (position < before.size) {
          const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, before.size - position),
            position,
          );
          if (!bytesRead) throw new Error("evidence truncated during read");
          const data = buffer.subarray(0, bytesRead);
          secondHash.update(data);
          const from = Math.max(windowStart, position),
            to = Math.min(windowEnd, position + bytesRead);
          if (to > from)
            chunks.push(
              Buffer.from(data.subarray(from - position, to - position)),
            );
          position += bytesRead;
        }
        if (secondHash.digest("hex") !== digest)
          throw new Error("evidence changed during read");
        selectedPage = { offset: windowStart, maxBytes };
        excerptInfo = {
          paragraphStart: paragraph.start,
          paragraphEnd: paragraph.end,
          windowStart,
          windowEnd: windowStart,
          omittedBefore: windowStart > paragraph.start,
          omittedAfter: false,
        };
      }
      const data = Buffer.concat(chunks);
      if (data.length && (data[0] & 0xc0) === 0x80)
        throw new Error("invalid evidence offset");
      const after = await file.stat();
      const live = await stat(current);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        live.dev !== after.dev ||
        live.ino !== after.ino ||
        live.size !== after.size ||
        live.mtimeMs !== after.mtimeMs ||
        live.ctimeMs !== after.ctimeMs ||
        (await realpath(current)) !== resolved
      )
        throw new Error("evidence changed during read");
      if (query && !paragraph) throw new Error("no matching paragraph");
      const fullText = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(data, {
        stream: query
          ? !!excerptInfo &&
            excerptInfo.windowStart + data.length < excerptInfo.paragraphEnd
          : !!page && end < before.size,
      });
      let text = fullText;
      if (excerptInfo) {
        excerptInfo.windowEnd =
          excerptInfo.windowStart + Buffer.byteLength(fullText);
        excerptInfo.omittedAfter =
          excerptInfo.windowEnd < excerptInfo.paragraphEnd;
        if (!excerptInfo.omittedBefore && !excerptInfo.omittedAfter)
          text = text.trim();
      }
      if (
        query &&
        this.limits.maxFileBytes !== undefined &&
        Buffer.byteLength(text) > this.limits.maxFileBytes
      )
        throw new Error("matching paragraph exceeds excerpt limit");
      return {
        path,
        text,
        sha256: digest,
        dev: before.dev,
        ino: before.ino,
        ...(query ? { query } : {}),
        ...(selectedPage ? { page: selectedPage } : {}),
        ...(excerptInfo ? { excerpt: excerptInfo } : {}),
        ...(excerptInfo?.omittedAfter
          ? { nextOffset: excerptInfo.windowEnd }
          : !query && page && start + Buffer.byteLength(fullText) < before.size
            ? { nextOffset: start + Buffer.byteLength(fullText) }
            : {}),
      };
    } finally {
      await file.close();
    }
  }
  async read(
    path: string,
    options: { offset?: number; maxBytes?: number } = {},
  ): Promise<FileEvidence> {
    const page = {
      offset: options.offset ?? 0,
      maxBytes: options.maxBytes ?? 256 * 1024,
    };
    if (
      !Number.isSafeInteger(page.offset) ||
      page.offset < 0 ||
      !Number.isSafeInteger(page.maxBytes) ||
      page.maxBytes < 4
    )
      throw new Error("invalid evidence page");
    if (++this.calls > (this.limits.maxCalls ?? Infinity))
      throw new Error("evidence call limit reached");
    const snapshot = await this.snapshot(path, undefined, false, page);
    const size = Buffer.byteLength(snapshot.text);
    if (this.bytes + size > (this.limits.maxTotalBytes ?? Infinity))
      throw new Error("evidence byte limit reached");
    this.bytes += size;
    const id = randomUUID();
    this.receipts.set(id, { ...snapshot, id });
    return {
      id,
      path: snapshot.path,
      text: snapshot.text,
      sha256: snapshot.sha256,
      ...(snapshot.nextOffset === undefined
        ? {}
        : { nextOffset: snapshot.nextOffset }),
    };
  }
  async excerpt(
    path: string,
    query: string,
    options: { offset?: number; maxBytes?: number } = {},
  ): Promise<FileEvidence> {
    if (!query.trim()) throw new Error("invalid evidence query");
    const maxBytes = options.maxBytes ?? 256 * 1024;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 4 ||
      (options.offset !== undefined &&
        (!Number.isSafeInteger(options.offset) || options.offset < 0))
    )
      throw new Error("invalid evidence page");
    return this.capture(
      path,
      query,
      false,
      options.offset === undefined
        ? undefined
        : { offset: options.offset, maxBytes },
      maxBytes,
    );
  }
  async missing(path: string): Promise<FileEvidence> {
    return this.capture(path, undefined, true);
  }
  private async capture(
    path: string,
    query?: string,
    missing = false,
    page?: { offset: number; maxBytes: number },
    maxBytes?: number,
  ): Promise<FileEvidence> {
    if (++this.calls > (this.limits.maxCalls ?? Infinity))
      throw new Error("evidence call limit reached");
    const snapshot = await this.snapshot(path, query, missing, page, maxBytes);
    const size = Buffer.byteLength(snapshot.text);
    if (this.bytes + size > (this.limits.maxTotalBytes ?? Infinity))
      throw new Error("evidence byte limit reached");
    this.bytes += size;
    const id = randomUUID();
    this.receipts.set(id, { ...snapshot, id });
    return {
      id,
      path,
      text: snapshot.text,
      sha256: snapshot.sha256,
      ...(snapshot.nextOffset === undefined
        ? {}
        : { nextOffset: snapshot.nextOffset }),
      ...(snapshot.excerpt ? { excerpt: snapshot.excerpt } : {}),
    };
  }
  /** Public-path inventory; never follows links or descends dependency trees. */
  async discover(
    options: { offset?: number; limit?: number; snapshot?: string } = {},
  ): Promise<{
    paths: string[];
    truncated: boolean;
    nextOffset?: number;
    snapshot?: string;
    changed?: boolean;
  }> {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 4096;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1))
    )
      throw new Error("invalid discovery page");
    if (offset > 0 && !options.snapshot)
      return { paths: [], truncated: true, changed: true };
    if (
      options.snapshot !== undefined &&
      !/^[0-9a-f]{64}$/.test(options.snapshot)
    )
      throw new Error("invalid discovery snapshot");
    const root = await realpath(this.root);
    const inventoryHash = createHash("sha256");
    const paths: string[] = [];
    let truncated = false;
    let seen = 0;
    let nextOffset: number | undefined;
    const walk = async function* (dir: string): AsyncGenerator<string> {
      const directory = resolve(root, dir);
      const before = await lstat(directory);
      if (before.isSymbolicLink() || !before.isDirectory()) {
        truncated = true;
        return;
      }
      const resolved = await realpath(directory);
      const rel = relative(root, resolved);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        truncated = true;
        return;
      }
      inventoryHash.update(
        JSON.stringify([
          "directory",
          dir,
          before.dev,
          before.ino,
          before.mtimeMs,
          before.ctimeMs,
        ]) + "\n",
      );
      const handle = await opendir(directory);
      try {
        for await (const entry of handle) {
          if (
            entry.name.startsWith(".") ||
            /^(?:node_modules|vendor|dist|build|tmp|credentials?|secrets?|auth)(?:\.|$)/i.test(
              entry.name,
            ) ||
            /\.(?:pem|key|p12|pfx|kdbx)$/i.test(entry.name)
          )
            continue;
          const path = dir ? `${dir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) yield* walk(path);
          else if (entry.isFile()) yield path;
        }
      } finally {
        const after = await lstat(directory);
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          after.isSymbolicLink() ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          truncated = true;
      }
    };
    for await (const path of walk("")) {
      inventoryHash.update(JSON.stringify(["file", path]) + "\n");
      if (seen++ < offset) continue;
      if (paths.length === limit) {
        nextOffset = offset + paths.length;
        continue;
      }
      paths.push(path);
    }
    const snapshot = inventoryHash.digest("hex");
    if (
      truncated ||
      (options.snapshot !== undefined && options.snapshot !== snapshot)
    )
      return { paths: [], truncated: true, changed: true };
    return {
      paths,
      truncated: nextOffset !== undefined,
      snapshot,
      ...(nextOffset === undefined ? {} : { nextOffset }),
    };
  }
  /** Search an inventory; each match is a revalidated paragraph receipt. */
  async search(
    paths: string[],
    query: string,
    options: {
      offset?: number;
      limit?: number;
      maxMatches?: number;
      snapshot?: string;
    } = {},
  ): Promise<{
    files: FileEvidence[];
    examined: number;
    incomplete: boolean;
    nextOffset?: number;
    snapshot?: string;
    changed?: boolean;
  }> {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 256;
    const maxMatches = options.maxMatches ?? 32;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) ||
      (maxMatches !== Infinity &&
        (!Number.isSafeInteger(maxMatches) || maxMatches < 1))
    )
      throw new Error("invalid search page");
    if (!query.trim()) throw new Error("invalid evidence query");
    if (
      options.snapshot !== undefined &&
      !/^[0-9a-f]{64}$/.test(options.snapshot)
    )
      throw new Error("invalid search snapshot");
    const hash = createHash("sha256");
    hash.update(JSON.stringify(["query", query]) + "\n");
    for (const path of paths)
      hash.update(JSON.stringify(["path", path]) + "\n");
    const snapshot = hash.digest("hex");
    if (
      (offset > 0 && !options.snapshot) ||
      (options.snapshot !== undefined && options.snapshot !== snapshot)
    )
      return { files: [], examined: 0, incomplete: true, changed: true };
    if (offset > paths.length) throw new Error("invalid search page");
    const files: FileEvidence[] = [];
    let examined = 0,
      incomplete = paths.length === 0;
    let nextOffset: number | undefined;
    for (let index = offset; index < paths.length; index++) {
      if (examined >= limit || files.length >= maxMatches) {
        nextOffset = index;
        incomplete = true;
        break;
      }
      const path = paths[index];
      examined++;
      try {
        const match = await this.snapshot(path, query);
        const id = randomUUID();
        const size = Buffer.byteLength(match.text);
        if (
          ++this.calls > (this.limits.maxCalls ?? Infinity) ||
          this.bytes + size > (this.limits.maxTotalBytes ?? Infinity)
        ) {
          incomplete = true;
          nextOffset = index;
          examined--;
          break;
        }
        this.bytes += size;
        this.receipts.set(id, { ...match, id });
        files.push({
          id,
          path,
          text: match.text,
          sha256: match.sha256,
          ...(match.nextOffset === undefined
            ? {}
            : { nextOffset: match.nextOffset }),
          ...(match.excerpt ? { excerpt: match.excerpt } : {}),
        });
      } catch (error: any) {
        if (error?.message !== "no matching paragraph") incomplete = true;
      }
    }
    return {
      files,
      examined,
      incomplete,
      snapshot,
      ...(nextOffset === undefined ? {} : { nextOffset }),
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
    const current = await this.snapshot(
      receipt.path,
      receipt.query,
      receipt.missing,
      receipt.page,
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
      ...(receipt.nextOffset === undefined
        ? {}
        : { nextOffset: receipt.nextOffset }),
      ...(receipt.excerpt ? { excerpt: receipt.excerpt } : {}),
    };
  }
}
