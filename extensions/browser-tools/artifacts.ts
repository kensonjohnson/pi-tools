import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
  link,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const NAME = /^([0-9a-f-]{36})-([a-f0-9]{64})-([0-9]{13})\.(txt|bin)$/;
const ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEMP = /^\.tmp-[0-9a-f-]{36}$/;
const ownerKey = (owner: string) =>
  createHash("sha256").update(owner).digest("hex");
const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error("Artifact operation cancelled.");
};
const defaultRoot = () => join(homedir(), ".pi", "agent", "browser-artifacts");

class ArtifactRecoveryError extends Error {
  constructor(cause: unknown) {
    super(
      "Artifact publication recovery could not be verified; the store lock is retained for manual inspection.",
      { cause },
    );
  }
}

async function directory(path: string, create: boolean, privateMode = true) {
  if (create)
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isDirectory() || stat.uid !== process.getuid?.())
      throw new Error("Unsafe artifact directory owner or type.");
    if (privateMode) await file.chmod(0o700);
    const current = await lstat(path);
    if (
      current.isSymbolicLink() ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino
    )
      throw new Error("Artifact directory changed.");
  } finally {
    await file.close();
  }
}
async function safeFile(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = await file.stat();
    const current = await lstat(path);
    if (
      !st.isFile() ||
      st.uid !== process.getuid?.() ||
      st.nlink !== 1 ||
      (st.mode & 0o077) !== 0 ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== st.dev ||
      current.ino !== st.ino ||
      current.nlink !== 1
    )
      throw new Error("Unsafe artifact file.");
    return { file, st };
  } catch (error) {
    await file.close();
    throw error;
  }
}
async function nextChunk<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<IteratorResult<T>> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () =>
      finish(() => reject(new Error("Artifact operation cancelled.")));
    const timer = setTimeout(
      () => finish(() => reject(new Error("Artifact source timed out."))),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => iterator.next())
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });
}
async function closeIterator(
  iterator: AsyncIterator<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  if (!iterator.return) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => iterator.return!())
        .then(
          () => true,
          () => false,
        ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeParents(path: string) {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let cursor = sep;
  for (const part of parts) {
    cursor = join(cursor, part);
    const st = await lstat(cursor);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new Error(
        "Export directory contains a symlink or is not a directory.",
      );
    if (
      cursor === absolute &&
      (st.uid !== process.getuid?.() || (st.mode & 0o022) !== 0)
    )
      throw new Error(
        "Export directory must be owned by this user and not group/world writable.",
      );
  }
}

/**
 * Cross-process serialization uses an atomic directory; a crashed holder fails closed.
 * This is not a sandbox against a concurrent process with the same OS user: Node's
 * pathname APIs cannot prevent a same-user parent-directory swap between checks and
 * use. Expiry cleanup is opportunistic on store access, not a background timer.
 * The lock directory is not fsynced. Process-crash quarantine does not prove safety
 * after power loss; filesystem metadata and quota state may need manual inspection.
 */
export class ArtifactStore {
  readonly root: string;
  readonly quota: number;
  readonly ttl: number;
  private readonly now: () => number;
  private readonly publication: { link: typeof link; unlink: typeof unlink };
  private readonly lockStat: typeof lstat;
  private readonly releaseLock: typeof rmdir;
  private readonly syncDirectory: (path: string) => Promise<void>;
  constructor(
    options: {
      root?: string;
      quota?: number;
      ttl?: number;
      now?: () => number;
      /** Filesystem fault injection for tests. */
      publication?: { link?: typeof link; unlink?: typeof unlink };
      lockStat?: typeof lstat;
      releaseLock?: typeof rmdir;
      syncDirectory?: (path: string) => Promise<void>;
    } = {},
  ) {
    this.root = resolve(options.root ?? defaultRoot());
    this.quota = options.quota ?? 256 * 1024 * 1024;
    this.ttl = options.ttl ?? 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.publication = {
      link: options.publication?.link ?? link,
      unlink: options.publication?.unlink ?? unlink,
    };
    this.lockStat = options.lockStat ?? lstat;
    this.releaseLock = options.releaseLock ?? rmdir;
    this.syncDirectory =
      options.syncDirectory ??
      (async (path) => {
        const dir = await open(
          path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      });
    if (
      !Number.isSafeInteger(this.quota) ||
      this.quota < 1 ||
      !Number.isSafeInteger(this.ttl) ||
      this.ttl < 1
    )
      throw new Error("Invalid artifact limits.");
  }
  private async initialize() {
    if (this.root === resolve(defaultRoot())) {
      if ((await realpath(homedir())) !== resolve(homedir()))
        throw new Error("Artifact parent must not contain symlinks.");
      await directory(join(homedir(), ".pi"), true, false);
      await directory(join(homedir(), ".pi", "agent"), true, false);
    }
    if ((await realpath(dirname(this.root))) !== dirname(this.root))
      throw new Error("Artifact parent must not contain symlinks.");
    await directory(this.root, true);
    if ((await realpath(this.root)) !== this.root)
      throw new Error("Artifact root must not contain symlinks.");
  }
  private async locked<T extends object>(
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T & { lockWarning?: string }> {
    aborted(signal);
    await this.initialize();
    const lock = join(this.root, ".lock");
    const deadline = Date.now() + 5000;
    for (;;) {
      aborted(signal);
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stat;
        try {
          stat = await this.lockStat(lock);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT")
            throw statError;
          if (Date.now() >= deadline)
            throw new Error("Artifact store lock wait deadline exceeded.");
          continue;
        }
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid?.()
        )
          throw new Error("Unsafe artifact lock.");
        if (Date.now() >= deadline)
          throw new Error(
            "Artifact store is busy or a crashed operation left its lock; manual inspection is required.",
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    let value: T;
    try {
      aborted(signal);
      value = await work();
    } catch (error) {
      if (error instanceof ArtifactRecoveryError) throw error;
      try {
        await this.releaseLock(lock);
      } catch {
        throw new Error(
          `${String(error).slice(0, 2000)} Lock cleanup also failed at ${lock}; manual inspection is required before further store operations.`,
          { cause: error },
        );
      }
      throw error;
    }
    try {
      await this.releaseLock(lock);
      return value;
    } catch {
      return {
        ...value,
        lockWarning: `The operation completed, but lock cleanup failed at ${lock}. Further store operations may be blocked; inspect ownership and resolve the lock manually before retrying.`,
      };
    }
  }
  private async scan(now: number, signal?: AbortSignal) {
    const names = await readdir(this.root);
    if (names.length > 10000)
      throw new Error("Artifact store entry limit exceeded.");
    let bytes = 0;
    const entries: {
      id: string;
      owner: string;
      expires: number;
      path: string;
      bytes: number;
      kind: "txt" | "bin";
    }[] = [];
    for (const name of names) {
      aborted(signal);
      if (name === ".lock") continue;
      const match = NAME.exec(name);
      if (!match && !TEMP.test(name))
        throw new Error("Unsafe or unknown artifact store entry.");
      const path = join(this.root, name);
      const { file, st } = await safeFile(path);
      await file.close();
      if (!match) {
        bytes += st.size;
        continue;
      } // Crashed writes are retained and counted, never guessed safe to delete.
      if (!ID.test(match[1])) throw new Error("Invalid artifact filename.");
      const expires = Number(match[3]);
      if (expires <= now) {
        await unlink(path);
        continue;
      }
      bytes += st.size;
      entries.push({
        id: match[1],
        owner: match[2],
        expires,
        path,
        bytes: st.size,
        kind: match[4] as "txt" | "bin",
      });
    }
    return { entries, bytes };
  }
  /** Roll back only names that still refer to the private inode created by this write. */
  private async rollbackPublication(
    temp: string,
    path: string,
    identity: Stats,
    linked: boolean,
  ) {
    const inspect = async (name: string): Promise<Stats | undefined> => {
      let stat: Stats;
      try {
        stat = await lstat(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.dev !== identity.dev ||
        stat.ino !== identity.ino
      )
        throw new Error("Publication file was replaced; refusing rollback.");
      return stat;
    };
    const staged = await inspect(temp);
    // A failed link must never authorize deleting an existing destination.
    const published = linked ? await inspect(path) : undefined;
    const expectedLinks = Number(Boolean(staged)) + Number(Boolean(published));
    if (
      (staged && staged.nlink !== expectedLinks) ||
      (published && published.nlink !== expectedLinks)
    )
      throw new Error(
        "Publication inode has unexpected hard links; refusing rollback.",
      );
    if (published) await this.publication.unlink(path);
    if (staged) await this.publication.unlink(temp);
  }

  async put(owner: string, text: string, signal?: AbortSignal) {
    aborted(signal);
    if (!text.isWellFormed())
      throw new Error(
        "Result contains unpaired UTF-16 surrogates and cannot be represented losslessly as UTF-8.",
      );
    if (Buffer.byteLength(text, "utf8") > this.quota)
      throw new Error("Artifact quota exceeded; full result was not saved.");
    const data = Buffer.from(text, "utf8");
    return this.putStream(
      owner,
      (async function* () {
        yield data;
      })(),
      "txt",
      this.quota,
      signal,
    );
  }

  /** Consume and publish binary data under the same lock, quota and expiry as text. */
  async putBinary(
    owner: string,
    data: AsyncIterable<Uint8Array>,
    options: {
      maxBytes: number;
      signal?: AbortSignal;
      sourceTimeoutMs?: number;
      cleanupTimeoutMs?: number;
    },
  ) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
      throw new Error("Invalid binary artifact size limit.");
    const sourceTimeout = options.sourceTimeoutMs ?? 30000;
    const cleanupTimeout = options.cleanupTimeoutMs ?? 1000;
    if (
      ![sourceTimeout, cleanupTimeout].every(
        (value) => Number.isSafeInteger(value) && value > 0 && value <= 300000,
      )
    )
      throw new Error("Invalid artifact source timeout.");
    return this.putStream(
      owner,
      data,
      "bin",
      options.maxBytes,
      options.signal,
      sourceTimeout,
      cleanupTimeout,
    );
  }

  private async putStream(
    owner: string,
    data: AsyncIterable<Uint8Array>,
    kind: "txt" | "bin",
    maxBytes: number,
    signal?: AbortSignal,
    sourceTimeoutMs = 30000,
    cleanupTimeoutMs = 1000,
  ) {
    return this.locked(signal, async () => {
      const now = this.now();
      const expires = now + this.ttl;
      if (!Number.isSafeInteger(expires) || String(expires).length !== 13)
        throw new Error("Invalid artifact expiry.");
      const { bytes } = await this.scan(now, signal);
      const id = randomUUID();
      const path = join(
        this.root,
        `${id}-${ownerKey(owner)}-${expires}.${kind}`,
      );
      const temp = join(this.root, `.tmp-${randomUUID()}`);
      let handle;
      let created = false;
      let identity: Stats | undefined;
      let linked = false;
      try {
        handle = await open(
          temp,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        created = true;
        identity = await handle.stat();
        let length = 0;
        const iterator = data[Symbol.asyncIterator]();
        let finished = false;
        try {
          for (;;) {
            const result = await nextChunk(iterator, signal, sourceTimeoutMs);
            if (result.done) {
              finished = true;
              break;
            }
            const chunk = result.value;
            aborted(signal);
            if (!(chunk instanceof Uint8Array))
              throw new Error("Invalid artifact stream chunk.");
            length += chunk.byteLength;
            if (!Number.isSafeInteger(length) || length > maxBytes)
              throw new Error(
                "Artifact size limit exceeded; full result was not saved.",
              );
            if (length > this.quota - bytes)
              throw new Error(
                "Artifact quota exceeded; full result was not saved.",
              );
            let offset = 0;
            while (offset < chunk.byteLength) {
              aborted(signal);
              const { bytesWritten } = await handle.write(
                chunk,
                offset,
                chunk.byteLength - offset,
              );
              if (!bytesWritten) throw new Error("Artifact write failed.");
              offset += bytesWritten;
            }
          }
        } catch (error) {
          if (!finished && !(await closeIterator(iterator, cleanupTimeoutMs)))
            throw new Error(
              `${error instanceof Error ? error.message : String(error)} Source cleanup unverified; it may still be running. No artifact was published.`,
              { cause: error },
            );
          throw error;
        }
        aborted(signal);
        await handle.sync();
        await handle.close();
        handle = undefined;
        // link is no-clobber, unlike rename; the private staging name is removed before publication completes.
        aborted(signal);
        await this.publication.link(temp, path);
        linked = true;
        await this.publication.unlink(temp);
        await this.syncDirectory(this.root);
        return { id, path, bytes: length, expiresAt: expires };
      } catch (error) {
        try {
          await handle?.close();
          if (created) {
            if (!identity)
              throw new Error("Staging inode identity unavailable.");
            await this.rollbackPublication(temp, path, identity, linked);
            await this.syncDirectory(this.root);
          }
        } catch (recoveryError) {
          throw new ArtifactRecoveryError(recoveryError);
        }
        throw error;
      }
    });
  }
  private async lookup(owner: string, id: string, signal?: AbortSignal) {
    if (!ID.test(id)) throw new Error("Invalid artifact ID.");
    const { entries } = await this.scan(this.now(), signal);
    const entry = entries.find(
      (item) => item.id === id && item.owner === ownerKey(owner),
    );
    if (!entry)
      throw new Error(
        "Artifact unavailable, expired, or owned by another session.",
      );
    return entry;
  }
  async read(
    owner: string,
    id: string,
    offset = 0,
    maxBytes = 65536,
    signal?: AbortSignal,
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 4 ||
      maxBytes > 65536
    )
      throw new Error("Invalid artifact chunk offset or size.");
    return this.locked(signal, async () => {
      const entry = await this.lookup(owner, id, signal);
      if (entry.kind !== "txt")
        throw new Error("Binary artifact requires base64 chunk retrieval.");
      if (offset > entry.bytes)
        throw new Error("Artifact offset exceeds its length.");
      const { file, st } = await safeFile(entry.path);
      try {
        if (st.size !== entry.bytes)
          throw new Error("Artifact changed during read.");
        const data = Buffer.alloc(Math.min(maxBytes + 1, entry.bytes - offset));
        const { bytesRead } = await file.read(data, 0, data.length, offset);
        if (bytesRead !== data.length)
          throw new Error("Artifact changed during read.");
        if (offset < entry.bytes && (data[0] & 0xc0) === 0x80)
          throw new Error("Offset is not a UTF-8 character boundary.");
        let length = Math.min(maxBytes, data.length);
        while (
          length < data.length &&
          length > 0 &&
          (data[length] & 0xc0) === 0x80
        )
          length--;
        const text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(data.subarray(0, length));
        aborted(signal);
        const nextOffset = offset + length;
        return {
          id,
          bytes: entry.bytes,
          offset,
          chunkBytes: length,
          nextOffset: nextOffset < entry.bytes ? nextOffset : null,
          encoding: "utf-8" as const,
          text,
          expiresAt: entry.expires,
        };
      } finally {
        await file.close();
      }
    });
  }
  /** Offsets and limits are raw bytes; payload is base64 without text decoding. */
  async readBinary(
    owner: string,
    id: string,
    offset = 0,
    maxBytes = 32768,
    signal?: AbortSignal,
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 32768
    )
      throw new Error("Invalid binary artifact chunk offset or size.");
    return this.locked(signal, async () => {
      const entry = await this.lookup(owner, id, signal);
      if (entry.kind !== "bin")
        throw new Error("Text artifact requires UTF-8 chunk retrieval.");
      if (offset > entry.bytes)
        throw new Error("Artifact offset exceeds its length.");
      const { file, st } = await safeFile(entry.path);
      try {
        if (st.size !== entry.bytes)
          throw new Error("Artifact changed during read.");
        const data = Buffer.alloc(Math.min(maxBytes, entry.bytes - offset));
        const { bytesRead } = await file.read(data, 0, data.length, offset);
        if (bytesRead !== data.length)
          throw new Error("Artifact changed during read.");
        aborted(signal);
        const nextOffset = offset + bytesRead;
        return {
          id,
          bytes: entry.bytes,
          offset,
          chunkBytes: bytesRead,
          nextOffset: nextOffset < entry.bytes ? nextOffset : null,
          encoding: "base64" as const,
          data: data.toString("base64"),
          expiresAt: entry.expires,
        };
      } finally {
        await file.close();
      }
    });
  }
  async export(
    owner: string,
    id: string,
    destination: string,
    signal?: AbortSignal,
  ) {
    if (!isAbsolute(destination) || destination.includes("\0"))
      throw new Error("Export destination must be an absolute file path.");
    const target = resolve(destination);
    if (target === this.root || target.startsWith(this.root + sep))
      throw new Error(
        "Export destination must be outside the managed artifact root.",
      );
    return this.locked(signal, async () => {
      const entry = await this.lookup(owner, id, signal);
      const parent = dirname(target);
      await safeParents(parent);
      const { file, st } = await safeFile(entry.path);
      const temp = join(parent, `.browser-export-${randomUUID()}`);
      let out;
      let created = false;
      let identity: Stats | undefined;
      try {
        try {
          out = await open(
            temp,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          created = true;
          identity = await out.stat();
          const buffer = Buffer.alloc(65536);
          let offset = 0;
          while (offset < st.size) {
            aborted(signal);
            const { bytesRead } = await file.read(
              buffer,
              0,
              Math.min(buffer.length, st.size - offset),
              offset,
            );
            if (!bytesRead) throw new Error("Artifact changed during export.");
            let written = 0;
            while (written < bytesRead) {
              const result = await out.write(
                buffer,
                written,
                bytesRead - written,
              );
              if (!result.bytesWritten) throw new Error("Export write failed.");
              written += result.bytesWritten;
            }
            offset += bytesRead;
          }
          await out.sync();
          await out.close();
          out = undefined;
          aborted(signal);
          await safeParents(parent);
          await this.publication.link(temp, target); // atomic no-overwrite publication
        } catch (error) {
          try {
            await out?.close();
            out = undefined;
            if (created) {
              if (!identity)
                throw new Error("Export staging inode identity unavailable.");
              await safeParents(parent);
              await this.rollbackPublication(temp, target, identity, false);
              await this.syncDirectory(parent);
            }
          } catch (cleanupError) {
            throw new Error(
              `Export was not published; staging cleanup or its durability could not be verified at ${temp}. Inspect it manually.`,
              { cause: cleanupError },
            );
          }
          throw error;
        }
        // Publication is already complete. Never report an ordinary failure after
        // this point: callers must know that retrying would encounter the destination.
        let cleanup: "complete" | "unverified" = "complete";
        try {
          await safeParents(parent);
          const staged = await lstat(temp);
          const published = await lstat(target);
          if (
            !identity ||
            !staged.isFile() ||
            staged.isSymbolicLink() ||
            !published.isFile() ||
            published.isSymbolicLink() ||
            staged.uid !== process.getuid?.() ||
            published.uid !== process.getuid?.() ||
            staged.dev !== identity.dev ||
            staged.ino !== identity.ino ||
            published.dev !== identity.dev ||
            published.ino !== identity.ino ||
            staged.nlink !== 2 ||
            published.nlink !== 2
          )
            throw new Error("Export publication identity changed.");
          await this.publication.unlink(temp);
        } catch {
          cleanup = "unverified";
        }
        let durability: "synced" | "unverified" = "synced";
        try {
          await safeParents(parent);
          await this.syncDirectory(parent);
        } catch {
          durability = "unverified";
        }
        return {
          id,
          path: target,
          bytes: st.size,
          published: true as const,
          cleanup,
          durability,
          ...(cleanup === "unverified" ? { stagingPath: temp } : {}),
          ...(cleanup === "unverified" || durability === "unverified"
            ? {
                notice:
                  "Export was published. Inspect the indicated staging path and/or directory durability before retrying; the destination already exists.",
              }
            : {}),
        };
      } finally {
        await file.close().catch(() => {});
      }
    });
  }
  async cleanup(signal?: AbortSignal) {
    return this.locked(signal, async () => {
      const result = await this.scan(this.now(), signal);
      return { bytes: result.bytes, count: result.entries.length };
    });
  }
}
