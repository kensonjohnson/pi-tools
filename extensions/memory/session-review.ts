import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
  opendirSync,
  statSync,
  lstatSync,
  type Dir,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";

type Entry = {
  type: string;
  id: string;
  parentId: string | null;
  [key: string]: any;
};
type Progress = {
  id: string;
  dev: number;
  ino: number;
  size: number;
  hash: string;
  leaf: string | null;
};
type State = {
  version: 1;
  project: string;
  sessions: Record<string, Progress>;
};
export type ReviewIssue = { path?: string; reason: string };
export type ReviewItem = { id: string; role: string; text: string };
export type ReviewBatch = {
  path: string;
  sessionId: string;
  parentSession?: string;
  leaf: string | null;
  items: ReviewItem[];
  /** More entries remain on the snapshotted active branch. */
  more: boolean;
  acknowledge: () => void;
};
export type ReviewOptions = {
  project: string;
  sessionDir: string;
  checkpointFile: string;
  maxFileBytes?: number;
  maxTextBytes?: number;
  maxSessionsPerScan?: number;
  maxScanBytes?: number;
  maxScanTextBytes?: number;
  maxCheckpointBytes?: number;
};

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * Pi forkFrom copies a physical source prefix; createBranchedSession copies a
 * source branch, dropping labels and rechaining parent IDs. The fork header has
 * no immutable boundary: this checks known copied entries, not hostile forgery
 * of a novel ID after the verified prefix.
 */
export function verifyForkCopy(child: Entry[], parent: Entry[]): boolean {
  if (!child.length || !parent.length) return false;
  const byId = new Map(parent.map((entry) => [entry.id, entry]));
  const ownSuffix = (start: number) =>
    child.slice(start).every((entry) => !byId.has(entry.id));
  let direct = 0;
  while (
    direct < child.length &&
    direct < parent.length &&
    isDeepStrictEqual(child[direct], parent[direct])
  )
    direct++;
  if (direct > 0 && ownSuffix(direct)) return true;

  let copied = 0;
  let previous: string | null = null;
  while (copied < child.length) {
    const entry = child[copied];
    const original = byId.get(entry.id);
    if (!original) break;
    if (original.type === "label" || entry.parentId !== previous) return false;
    const { parentId: _childParent, ...childRest } = entry;
    const { parentId: _parentParent, ...parentRest } = original;
    if (!isDeepStrictEqual(childRest, parentRest)) return false;
    let ancestor = original.parentId;
    while (ancestor !== null && byId.get(ancestor)?.type === "label")
      ancestor = byId.get(ancestor)!.parentId;
    if (ancestor !== previous) return false;
    previous = entry.id;
    copied++;
  }
  return copied > 0 && ownSuffix(copied);
}
function textOf(content: unknown, role: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || (role === "user" && content.length === 0))
    throw new Error("unsupported or malformed conversation content");
  const text: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object")
      throw new Error("unsupported or malformed conversation block");
    if (block.type === "text" && typeof block.text === "string")
      text.push(block.text);
    else if (block.type === "image")
      throw new Error(
        "unsupported image content; session cannot be fully reviewed",
      );
    else if (
      role === "assistant" &&
      (block.type === "thinking" || block.type === "toolCall")
    )
      continue;
    else throw new Error("unsupported or malformed conversation block");
  }
  return text.join("\n");
}

/** Read a bounded stable snapshot without asking Pi to repair or migrate the source file. */
function snapshot(path: string, limit: number) {
  const fd = openSync(path, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > limit)
      throw new Error("source unavailable or exceeds file byte limit");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) throw new Error("source truncated during read");
      offset += n;
    }
    const after = fstatSync(fd);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    )
      throw new Error("source changed during read");
    if (!bytes.length || bytes[bytes.length - 1] !== 10)
      throw new Error("incomplete session tail");
    const lines = bytes.toString("utf8").split("\n");
    lines.pop();
    let entries: any[];
    try {
      entries = lines.map((line) => JSON.parse(line));
    } catch {
      throw new Error("malformed session line");
    }
    const header = entries.shift();
    if (
      !header ||
      header.type !== "session" ||
      typeof header.id !== "string" ||
      typeof header.cwd !== "string"
    )
      throw new Error("invalid session header");
    if (header.version !== 3) throw new Error("unsupported session version");
    const ids = new Set<string>();
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry.id !== "string" ||
        ids.has(entry.id) ||
        (entry.parentId !== null &&
          (typeof entry.parentId !== "string" || !ids.has(entry.parentId)))
      )
        throw new Error("invalid session tree");
      ids.add(entry.id);
    }
    // Pi restores the last persisted entry as the leaf and walks parent links to the root.
    const byId = new Map<string, Entry>(
      entries.map((entry) => [entry.id, entry]),
    );
    const leaf: string | null = entries.at(-1)?.id ?? null;
    const branch: Entry[] = [];
    let current = leaf;
    while (current !== null) {
      const entry = byId.get(current)!;
      branch.push(entry);
      current = entry.parentId;
    }
    branch.reverse();
    return {
      bytes,
      header,
      entries: entries as Entry[],
      branch,
      leaf,
      dev: before.dev,
      ino: before.ino,
    };
  } finally {
    closeSync(fd);
  }
}

/** Explicitly acknowledged batches alone update this project-specific checkpoint file. */
export class SessionReview {
  private readonly project: string;
  private readonly dir: string;
  private readonly checkpoint: string;
  private readonly maxFile: number;
  private readonly maxText: number;
  private readonly maxSessions: number;
  private readonly maxScan: number;
  private readonly maxScanText: number;
  private readonly maxCheckpoint: number;
  private cursor?: Dir;
  private pending?: string;
  constructor(options: ReviewOptions) {
    this.project = resolve(options.project);
    this.dir = resolve(options.sessionDir);
    this.checkpoint = resolve(options.checkpointFile);
    this.maxFile = options.maxFileBytes ?? 8 * 1024 * 1024;
    this.maxText = options.maxTextBytes ?? 64 * 1024;
    this.maxSessions = options.maxSessionsPerScan ?? 32;
    this.maxScan = options.maxScanBytes ?? 32 * 1024 * 1024;
    this.maxScanText = options.maxScanTextBytes ?? 256 * 1024;
    this.maxCheckpoint = options.maxCheckpointBytes ?? 8 * 1024 * 1024;
    if (
      [
        this.maxFile,
        this.maxText,
        this.maxSessions,
        this.maxScan,
        this.maxScanText,
        this.maxCheckpoint,
      ].some((n) => !Number.isSafeInteger(n) || n < 1)
    )
      throw new Error("invalid review limits");
    if (this.maxScanText < 2)
      throw new Error("maxScanTextBytes must be at least 2 bytes");
  }
  private load(): State {
    let raw: string;
    try {
      const fd = openSync(this.checkpoint, "r");
      try {
        const size = fstatSync(fd).size;
        if (size > this.maxCheckpoint)
          throw new Error("review checkpoint exceeds byte limit");
        const buffer = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const n = readSync(fd, buffer, offset, size - offset, offset);
          if (!n) throw new Error("review checkpoint truncated during read");
          offset += n;
        }
        if (fstatSync(fd).size !== size)
          throw new Error("review checkpoint changed during read");
        raw = buffer.toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error: any) {
      if (error.code === "ENOENT")
        return { version: 1, project: this.project, sessions: {} };
      throw error;
    }
    const state = JSON.parse(raw);
    if (
      state.version !== 1 ||
      state.project !== this.project ||
      !state.sessions ||
      typeof state.sessions !== "object" ||
      Array.isArray(state.sessions)
    )
      throw new Error("invalid or foreign review checkpoint");
    return state;
  }
  private save(state: State) {
    mkdirSync(dirname(this.checkpoint), { recursive: true, mode: 0o700 });
    const tmp = `${this.checkpoint}.${randomUUID()}.tmp`;
    try {
      const encoded = JSON.stringify(state);
      if (Buffer.byteLength(encoded) > this.maxCheckpoint)
        throw new Error("review checkpoint exceeds byte limit");
      writeFileSync(tmp, encoded, { mode: 0o600, flag: "wx" });
      renameSync(tmp, this.checkpoint);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }
  /** Close the scan cursor when the caller will not continue. */
  close(): void {
    this.cursor?.closeSync();
    this.cursor = undefined;
    this.pending = undefined;
  }
  private withCheckpointLock<T>(fn: () => T): T {
    mkdirSync(dirname(this.checkpoint), { recursive: true, mode: 0o700 });
    // Earlier versions used a lock file that cannot safely be recovered by PID.
    try {
      lstatSync(`${this.checkpoint}.lock`);
      throw new Error(
        "legacy review lock present; stop all old reviewers before explicitly removing it",
      );
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    // Never remove or replace this database while reviewers may be running.
    // SQLite releases its OS lock when a process dies, without PID guessing.
    const lockPath = `${this.checkpoint}.lock.db`;
    const fd = openSync(lockPath, "a", 0o600);
    closeSync(fd);
    const db = new Database(lockPath, { timeout: 0 });
    try {
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (error: any) {
        if (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
          throw new Error(
            "review checkpoint locked by another reviewer; retry",
          );
        throw error;
      }
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    } finally {
      db.close();
    }
  }
  discover(options: { continue?: boolean } = {}): {
    batches: ReviewBatch[];
    issues: ReviewIssue[];
    continuation: boolean;
  } {
    const state = this.load();
    const issues: ReviewIssue[] = [
      {
        reason:
          "Ephemeral sessions are unavailable; custom session directories outside the supplied directory are not discovered.",
      },
      {
        reason:
          "A live session's leaf navigation without a subsequent append is not persisted; the last persisted leaf is used.",
      },
    ];
    const batches: ReviewBatch[] = [];
    if (!options.continue) this.close();
    if (options.continue && !this.cursor)
      throw new Error("no active discovery continuation");
    try {
      this.cursor ??= opendirSync(this.dir);
    } catch (error: any) {
      issues.push({
        path: this.dir,
        reason: `session directory unavailable: ${error.message}`,
      });
      return { batches, issues, continuation: false };
    }
    let scanned = 0,
      bytes = 0,
      textBytes = 0;
    let done = false;
    while (scanned < this.maxSessions) {
      const name = this.pending ?? this.cursor.readSync()?.name;
      this.pending = undefined;
      if (name === undefined) {
        done = true;
        break;
      }
      scanned++;
      if (!name.endsWith(".jsonl")) continue;
      if (this.maxScanText - textBytes < 2) {
        this.pending = name;
        break;
      }
      const path = join(this.dir, name);
      const bytesBeforeSession = bytes;
      const workBeforeSession = scanned - 1;
      try {
        const size = statSync(path).size;
        if (size > this.maxFile || size > this.maxScan) {
          issues.push({
            path,
            reason: "session exceeds file or scan byte limit; unavailable",
          });
          continue;
        }
        if (size > this.maxScan - bytes) {
          this.pending = name;
          break;
        }
        const s = snapshot(path, Math.min(this.maxFile, this.maxScan - bytes));
        bytes += s.bytes.length;
        if (resolve(s.header.cwd) !== this.project) {
          issues.push({ path, reason: "excluded: different project" });
          continue;
        }
        // A fork can contain copied history from another cwd, including through
        // multiple generations. Fail closed if its entire provenance is not available.
        const parents: Array<{
          path: string;
          dev: number;
          ino: number;
          bytes: Buffer;
        }> = [];
        const visited = new Set([resolve(path)]);
        let childEntries = s.entries;
        let parent = s.header.parentSession;
        while (parent !== undefined) {
          if (
            typeof parent !== "string" ||
            !isAbsolute(parent) ||
            parents.length >= 8
          )
            throw new Error(
              "fork provenance unsupported or too deep; excluded",
            );
          const parentPath = resolve(parent);
          if (visited.has(parentPath))
            throw new Error("fork provenance cycle; excluded");
          visited.add(parentPath);
          if (++scanned > this.maxSessions) {
            if (workBeforeSession > 0) {
              this.pending = name;
              break;
            }
            throw new Error(
              "fork provenance exceeds scan work budget; excluded",
            );
          }
          let parentSize: number;
          try {
            parentSize = statSync(parentPath).size;
          } catch {
            throw new Error("fork provenance unavailable; excluded");
          }
          if (parentSize > this.maxFile)
            throw new Error(
              "fork provenance exceeds file byte limit; excluded",
            );
          if (parentSize > this.maxScan - bytes) {
            if (bytesBeforeSession > 0) {
              this.pending = name;
              break;
            }
            throw new Error(
              "fork provenance exceeds scan byte budget; excluded",
            );
          }
          const ancestor = snapshot(
            parentPath,
            Math.min(this.maxFile, this.maxScan - bytes),
          );
          bytes += ancestor.bytes.length;
          if (resolve(ancestor.header.cwd) !== this.project)
            throw new Error("cross-project fork provenance; excluded");
          if (!verifyForkCopy(childEntries, ancestor.entries))
            throw new Error(
              "fork copied history is unverifiable or tampered; excluded",
            );
          childEntries = ancestor.entries;
          parents.push({
            path: parentPath,
            dev: ancestor.dev,
            ino: ancestor.ino,
            bytes: ancestor.bytes,
          });
          parent = ancestor.header.parentSession;
        }
        if (this.pending === name) break;
        if (parents.length)
          issues.push({
            path,
            reason:
              "fork copied history verified against same-project ancestors; novel suffix treated as fork activity",
          });
        const previous = state.sessions[path];
        let start = 0;
        if (previous) {
          const same =
            previous.id === s.header.id &&
            previous.dev === s.dev &&
            previous.ino === s.ino &&
            Number.isSafeInteger(previous.size) &&
            previous.size >= 0 &&
            previous.size <= s.bytes.length &&
            hash(s.bytes.subarray(0, previous.size)) === previous.hash;
          if (!same)
            issues.push({
              path,
              reason: "session replaced or truncated; replaying active branch",
            });
          else if (previous.leaf !== null) {
            const index = s.branch.findIndex(
              (entry) => entry.id === previous.leaf,
            );
            if (index >= 0) start = index + 1;
            else
              issues.push({
                path,
                reason: "active branch changed; replaying active branch",
              });
          }
        }
        const items: ReviewItem[] = [];
        let end = start;
        let blocked = false;
        const budget = Math.min(this.maxText, this.maxScanText - textBytes);
        for (let index = start; index < s.branch.length; index++) {
          const entry = s.branch[index];
          if (entry.type === "message") {
            const message = entry.message;
            if (!message || typeof message.role !== "string") {
              issues.push({
                path,
                reason: `malformed message ${entry.id}; progress stops before it`,
              });
              blocked = true;
              break;
            }
            if (message.role === "user" || message.role === "assistant") {
              let text: string;
              try {
                text = textOf(message.content, message.role);
              } catch (error: any) {
                issues.push({
                  path,
                  reason: `${error.message} in ${entry.id}; progress stops before it`,
                });
                blocked = true;
                break;
              }
              if (text) {
                const item = { id: entry.id, role: message.role, text };
                if (
                  Buffer.byteLength(JSON.stringify([item])) > this.maxText ||
                  Buffer.byteLength(JSON.stringify([item])) > this.maxScanText
                ) {
                  issues.push({
                    path,
                    reason: `record ${entry.id} exceeds review byte limit; progress stops before it`,
                  });
                  blocked = true;
                  break;
                }
                if (
                  Buffer.byteLength(JSON.stringify([...items, item])) > budget
                )
                  break;
                items.push(item);
              }
            } else if (
              !["system", "toolResult", "custom", "bashExecution"].includes(
                message.role,
              )
            ) {
              issues.push({
                path,
                reason: `unsupported message role ${message.role} in ${entry.id}; progress stops before it`,
              });
              blocked = true;
              break;
            }
          }
          end = index + 1;
        }
        const more = end < s.branch.length;
        if (more && !blocked)
          issues.push({
            path,
            reason: "review text budget reached; more branch entries remain",
          });
        if (end === start && more) {
          if (!blocked) {
            this.pending = name;
            break;
          }
          continue;
        }
        if (
          previous &&
          start === s.branch.length &&
          previous.size === s.bytes.length
        )
          continue;
        textBytes += Buffer.byteLength(JSON.stringify(items));
        const batchLeaf = end > 0 ? s.branch[end - 1].id : null;
        const expected = JSON.stringify(previous ?? null);
        let acknowledged = false;
        batches.push({
          path,
          sessionId: s.header.id,
          parentSession: s.header.parentSession,
          leaf: batchLeaf,
          items,
          more,
          acknowledge: () => {
            if (acknowledged) throw new Error("batch already acknowledged");
            const current = snapshot(path, this.maxFile);
            if (
              current.header.id !== s.header.id ||
              current.dev !== s.dev ||
              current.ino !== s.ino ||
              current.bytes.length < s.bytes.length ||
              hash(current.bytes.subarray(0, s.bytes.length)) !==
                hash(s.bytes) ||
              (s.leaf !== null &&
                !current.branch.some((entry) => entry.id === s.leaf))
            )
              throw new Error(
                "session changed incompatibly before acknowledgement",
              );
            for (const parent of parents) {
              const currentParent = snapshot(parent.path, this.maxFile);
              if (
                currentParent.dev !== parent.dev ||
                currentParent.ino !== parent.ino ||
                currentParent.bytes.length < parent.bytes.length ||
                hash(currentParent.bytes.subarray(0, parent.bytes.length)) !==
                  hash(parent.bytes)
              )
                throw new Error(
                  "fork provenance changed before acknowledgement",
                );
            }
            this.withCheckpointLock(() => {
              const fresh = this.load();
              if (JSON.stringify(fresh.sessions[path] ?? null) !== expected)
                throw new Error("checkpoint changed before acknowledgement");
              fresh.sessions[path] = {
                id: s.header.id,
                dev: s.dev,
                ino: s.ino,
                size: s.bytes.length,
                hash: hash(s.bytes),
                leaf: batchLeaf,
              };
              this.save(fresh);
              acknowledged = true;
            });
          },
        });
      } catch (error: any) {
        issues.push({ path, reason: error.message });
      }
    }
    if (done) this.close();
    else
      issues.push({
        reason:
          "discovery budget reached; continue this scan on the same SessionReview instance",
      });
    return { batches, issues, continuation: !done };
  }
}
