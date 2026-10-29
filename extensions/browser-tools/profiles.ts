import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

// Retain uncertain locks for this process; the durable marker survives its exit.
const quarantinedLocks = new Set<Database.Database>();
// POSIX record locks are process-wide: closing any descriptor for a SQLite
// database can drop another connection's locks. Share arbitration across module
// instances in this process, and do not open *any* lock-file descriptor until
// the previous connection has closed. The marker remains the crash backstop.
const localLocksKey = Symbol.for("pi-tools.browser-profile-local-locks.v1");
const processGlobals = globalThis as typeof globalThis & {
  [key: symbol]: unknown;
};
const localLocks = (processGlobals[localLocksKey] ??= new Map<
  string,
  symbol
>()) as Map<string, symbol>;
const defaultRoot = () => join(homedir(), ".pi", "agent", "browser-profiles");
const cancelled = () => new Error("Profile lease wait cancelled.");
async function privateDirectory(path: string, chmodOwned = true) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const dir = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch(() => {
    throw new Error(`Profile directory is not an owned directory: ${path}`);
  });
  try {
    const stat = await dir.stat();
    if (!stat.isDirectory() || stat.uid !== process.getuid?.())
      throw new Error(`Profile directory is not an owned directory: ${path}`);
    if (chmodOwned) await dir.chmod(0o700);
  } finally {
    await dir.close();
  }
}

/** Validate pre-existing trees without traversing symlinks or accepting hard-linked files. */
async function validateProfileTree(
  root: string,
  signal: AbortSignal,
): Promise<void> {
  const directories = [root];
  while (directories.length) {
    if (signal.aborted) throw cancelled();
    const dir = directories.pop()!;
    const stat = await lstat(dir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.()
    )
      throw new Error(`Unsafe profile directory: ${dir}`);
    for (const entry of await readdir(dir)) {
      if (signal.aborted) throw cancelled();
      const path = join(dir, entry);
      const child = await lstat(path);
      if (child.uid !== process.getuid?.() || child.isSymbolicLink())
        throw new Error(
          `Unsafe profile entry (symlink or unowned): ${path}. Verify and resolve it manually; singleton locks are never removed automatically.`,
        );
      if (child.isDirectory()) directories.push(path);
      else if (!child.isFile() || child.nlink !== 1)
        throw new Error(
          `Unsafe profile entry (special file or hard link): ${path}`,
        );
    }
  }
}

/** Validate before SQLite sees metadata, and chmod only the verified open inode. */
async function validateLockFile(path: string, create: boolean): Promise<void> {
  let file;
  try {
    try {
      const existing = await lstat(path);
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        existing.uid !== process.getuid?.() ||
        existing.nlink !== 1
      )
        throw new Error(`Unsafe profile lock metadata: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return;
    }
    file = await open(
      path,
      constants.O_RDWR |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW |
        (create ? constants.O_CREAT : 0),
      0o600,
    );
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Unsafe profile lock metadata: ${path}`);
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1)
      throw new Error(`Unsafe profile lock metadata: ${path}`);
    const atPath = await lstat(path);
    if (
      !atPath.isFile() ||
      atPath.isSymbolicLink() ||
      atPath.dev !== stat.dev ||
      atPath.ino !== stat.ino ||
      atPath.nlink !== 1
    )
      throw new Error(`Unsafe profile lock metadata: ${path}`);
    await file.chmod(0o600);
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string) {
  const dir = await open(path, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
async function delay(signal: AbortSignal, ms: number) {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export type ProfileLease = {
  path: string;
  release(): Promise<void>;
  abandon(): void;
};

/** A durable marker outlives the OS lock if ownership becomes uncertain. */
export async function acquireProfile(
  name: string,
  options: { root?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ProfileLease> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))
    throw new Error(
      "Invalid profile name; use 1-64 letters, digits, underscores or hyphens.",
    );
  const root = resolve(options.root ?? defaultRoot());
  // Security boundary: the root and its parent must not be concurrently modified by
  // an adversarial same-user process. Pathname validation cannot prevent swaps after
  // validation or while Chromium runs; Chromium and SQLite open paths themselves.
  // Existing nested symlinks, hard links, and special files are rejected, never followed.
  if (!options.root) {
    await privateDirectory(join(homedir(), ".pi"), false);
    await privateDirectory(join(homedir(), ".pi", "agent"), false);
  }
  await privateDirectory(root);
  const path = join(root, `profile-${name}`);
  await privateDirectory(path);
  const lockPath = join(root, `lease-${name}.sqlite`);
  const marker = join(root, `lease-${name}.pending`);
  const canonicalRoot = await realpath(root);
  // macOS commonly uses a case-insensitive filesystem. Folding also safely
  // over-serializes distinct names on case-sensitive macOS volumes.
  const localKey = join(canonicalRoot, `lease-${name}.sqlite`);
  const key = process.platform === "darwin" ? localKey.toLowerCase() : localKey;
  const token = Symbol();
  let reserved = false;
  const releaseLocal = () => {
    if (reserved && localLocks.get(key) === token) localLocks.delete(key);
    reserved = false;
  };
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 30000,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let db: Database.Database | undefined;
  let locked = false;
  try {
    while (!reserved) {
      if (signal.aborted) throw cancelled();
      if (!localLocks.has(key)) {
        localLocks.set(key, token);
        reserved = true;
      } else await delay(signal, 100);
    }
    if (signal.aborted) throw cancelled();
    await validateLockFile(lockPath, true);
    for (const suffix of ["-journal", "-wal", "-shm"])
      await validateLockFile(lockPath + suffix, false);
    if (signal.aborted) throw cancelled();
    db = new Database(lockPath, { timeout: 0 });
    while (!locked) {
      if (signal.aborted) throw cancelled();
      try {
        db.exec("BEGIN IMMEDIATE");
        locked = true;
      } catch (error) {
        if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
        await delay(signal, 100);
      }
    }
    if (signal.aborted) throw cancelled();
    try {
      await lstat(marker);
      throw new Error(
        `Profile ownership is unresolved: ${marker}. Independently verify the owner and all browsers have terminated before manually removing the marker. PIDs can be reused; never blindly signal them.`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await validateProfileTree(path, signal);
    if (signal.aborted) throw cancelled();
    const nonce = randomUUID();
    const file = await open(marker, "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({ version: 1, pid: process.pid, nonce }) + "\n",
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(root);
    const ownedDb = db;
    let settled = false;
    const closeLock = () => {
      if (settled) return;
      settled = true;
      try {
        ownedDb.exec("ROLLBACK");
      } finally {
        ownedDb.close();
        releaseLocal();
      }
    };
    return {
      path,
      async release() {
        if (settled) return;
        try {
          const stat = await lstat(marker);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.uid !== process.getuid?.() ||
            stat.nlink !== 1
          )
            throw new Error("Profile ownership marker changed.");
          const record = JSON.parse(await readFile(marker, "utf8"));
          if (record.nonce !== nonce || record.pid !== process.pid)
            throw new Error("Profile ownership marker changed.");
          await unlink(marker);
          await syncDirectory(root);
        } finally {
          closeLock();
        }
      },
      abandon() {
        if (settled) return;
        settled = true;
        quarantinedLocks.add(ownedDb);
      },
    };
  } catch (error) {
    if (db) {
      try {
        if (locked) db.exec("ROLLBACK");
      } finally {
        db.close();
        releaseLocal();
      }
    } else releaseLocal();
    if (controller.signal.aborted && !options.signal?.aborted)
      throw new Error(
        `Profile lease wait timed out; profile is busy or has unverified ownership. Inspect ${marker} and verify all browsers have terminated before recovery; never blindly signal reused PIDs.`,
      );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
