import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import Database from "better-sqlite3";
import { SessionReview } from "./session-review.ts";
import type { MemoryReviewer } from "./reviewer.ts";

export type SchedulerStatus = {
  pending: number;
  unsupportedSessions: number;
  paused: boolean;
  inflight: boolean;
  status: string;
  cooldownUntil: number;
  unpersistedActivities: number;
  activityFlushPending: boolean;
};
export type SchedulerControl = {
  status(): SchedulerStatus;
  resume(): void;
  cancel(): void;
};
export type SchedulerOutcome = {
  status:
    | "done"
    | "pending"
    | "error"
    | "unresolved"
    | "uncertain"
    | "unsupported-session";
  detail?: string;
};
export type SchedulerClock = {
  now(): number;
  setTimeout(fn: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};
const defaultClock: SchedulerClock = {
  now: Date.now,
  setTimeout(fn, delay) {
    const t = setTimeout(fn, delay);
    t.unref();
    return t;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
export const UNSUPPORTED_FILE_SOURCE = "unsupported-file:";
function normalizeSource(source: string): string {
  return source.startsWith(UNSUPPORTED_FILE_SOURCE)
    ? UNSUPPORTED_FILE_SOURCE +
        resolve(source.slice(UNSUPPORTED_FILE_SOURCE.length))
    : resolve(source);
}

/** Write crash-surviving activity independently of SQLite's writer lock. */
export async function persistSchedulerActivity(
  runtimeDir: string,
  directories: readonly string[],
): Promise<void> {
  const spool = join(runtimeDir, "signals");
  await mkdir(spool, { recursive: true, mode: 0o700 });
  for (const dir of new Set(directories.map(normalizeSource))) {
    const id = randomUUID();
    const temp = join(spool, `.${id}.tmp`);
    const target = join(spool, `${id}.json`);
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ id, dir }), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, target);
    const directory = await open(spool, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export type SchedulerOptions = {
  project: string;
  runtimeDir: string;
  sessionDir: string;
  additionalSessionDirs?: string[];
  /** Persist explicitly unavailable file sources without treating them as directories. */
  additionalSources?: string[];
  shutdownGraceMs?: number;
  cooldownMs?: number;
  debounceMs?: number;
  retryMs?: number;
  clock?: SchedulerClock;
  work: (directory: string, signal: AbortSignal) => Promise<SchedulerOutcome>;
  onStatus?: (status: string) => void;
};

/** Durable pending generations; a separate SQLite write transaction owns the project claim. */
export class MemoryScheduler {
  private readonly options: SchedulerOptions;
  private readonly clock: SchedulerClock;
  private readonly db: Database.Database;
  private readonly claimPath: string;
  private readonly spoolDir: string;
  private readonly sessionDirs: string[];
  private readonly unwritten = new Set<string>();
  private writing?: Promise<void>;
  private flushing?: Promise<void>;
  private signalTimer?: unknown;
  private detached = false;
  private dbClosed = false;
  private nextDelay = 0;
  private timer?: unknown;
  private running?: Promise<void>;
  private controller?: AbortController;
  private closed = false;
  private cancelled = false;
  constructor(options: SchedulerOptions) {
    this.options = {
      ...options,
      project: resolve(options.project),
      sessionDir: resolve(options.sessionDir),
    };
    this.clock = options.clock ?? defaultClock;
    this.sessionDirs = [
      ...new Set(
        [
          options.sessionDir,
          ...(options.additionalSessionDirs ?? []),
          ...(options.additionalSources ?? []),
        ].map(normalizeSource),
      ),
    ];
    this.spoolDir = join(options.runtimeDir, "signals");
    for (const n of [
      options.cooldownMs ?? 300000,
      options.debounceMs ?? 30000,
      options.retryMs ?? 60000,
      options.shutdownGraceMs ?? 1000,
    ])
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error("invalid scheduler delay");
    mkdirSync(options.runtimeDir, { recursive: true, mode: 0o700 });
    chmodSync(options.runtimeDir, 0o700);
    mkdirSync(this.spoolDir, { recursive: true, mode: 0o700 });
    chmodSync(this.spoolDir, 0o700);
    try {
      writeFileSync(
        join(options.runtimeDir, ".gitignore"),
        "*\n!.gitignore\n",
        { flag: "wx", mode: 0o600 },
      );
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
    }
    const path = join(options.runtimeDir, "scheduler.sqlite");
    this.claimPath = join(options.runtimeDir, "scheduler-claim.sqlite");
    for (const file of [path, this.claimPath]) {
      const fd = openSync(file, "a", 0o600);
      closeSync(fd);
      chmodSync(file, 0o600);
    }
    this.db = new Database(path, { timeout: 0 });
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), project TEXT NOT NULL, cooldown INTEGER NOT NULL, inflight INTEGER NOT NULL, paused INTEGER NOT NULL, status TEXT NOT NULL); CREATE TABLE IF NOT EXISTS directories (path TEXT PRIMARY KEY, pending INTEGER NOT NULL, completed INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS processed_signals (id TEXT PRIMARY KEY)",
      );
      this.db
        .prepare("INSERT OR IGNORE INTO meta VALUES (1, ?, 0, 0, 0, 'idle')")
        .run(this.options.project);
      const meta = this.db
        .prepare("SELECT project FROM meta WHERE id=1")
        .get() as { project: string };
      if (meta.project !== this.options.project)
        throw new Error("scheduler state belongs to another project");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  status(): SchedulerStatus {
    const meta = this.db
      .prepare("SELECT paused, inflight, status, cooldown FROM meta WHERE id=1")
      .get() as any;
    const count = this.db
      .prepare("SELECT COUNT(*) AS n FROM directories WHERE pending>completed")
      .get() as any;
    const unsupported = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM directories WHERE pending>completed AND substr(path,1,?)=?",
      )
      .get(UNSUPPORTED_FILE_SOURCE.length, UNSUPPORTED_FILE_SOURCE) as any;
    return {
      pending: count.n,
      unsupportedSessions: unsupported.n,
      paused: !!meta.paused,
      inflight: !!meta.inflight,
      status: meta.status,
      cooldownUntil: meta.cooldown,
      unpersistedActivities: this.unwritten.size,
      activityFlushPending:
        this.unwritten.size > 0 ||
        !!this.writing ||
        !!this.flushing ||
        this.signalTimer !== undefined,
    };
  }
  start(): void {
    if (!this.closed) {
      void this.flushSignals().catch(() => this.retrySignals());
      this.schedule(0);
    }
  }
  async waitForIdle(): Promise<void> {
    await this.running;
  }
  async waitForSignals(): Promise<void> {
    await this.writing;
    await this.flushing;
  }
  async activity(): Promise<void> {
    if (this.closed) return;
    for (const dir of this.sessionDirs) this.unwritten.add(dir);
    await this.persistActivities();
  }
  private retrySignals(): void {
    if (this.closed || this.signalTimer !== undefined) return;
    try {
      this.options.onStatus?.("activity-persist-pending");
    } catch {}
    this.signalTimer = this.clock.setTimeout(() => {
      this.signalTimer = undefined;
      void this.persistActivities().catch(() => this.retrySignals());
    }, this.options.retryMs ?? 60000);
  }
  private async persistActivities(): Promise<void> {
    if (this.writing) {
      await this.writing;
      if (this.unwritten.size) await this.persistActivities();
      return;
    }
    this.writing = (async () => {
      while (this.unwritten.size) {
        const dir = this.unwritten.values().next().value as string;
        await persistSchedulerActivity(this.options.runtimeDir, [dir]);
        this.unwritten.delete(dir);
      }
      if (!this.closed) {
        if (this.flushing) await this.flushing;
        await this.flushSignals();
      }
    })()
      .catch((error) => {
        this.retrySignals();
        throw error;
      })
      .finally(() => {
        this.writing = undefined;
        if (this.unwritten.size) this.retrySignals();
      });
    return this.writing;
  }
  private async flushSignals(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const dir = await opendir(this.spoolDir);
      let visited = 0;
      try {
        for await (const entry of dir) {
          if (this.closed) break;
          if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/.test(entry.name))
            continue;
          if (++visited > 100) {
            this.retrySignals();
            break;
          }
          const path = join(this.spoolDir, entry.name);
          let signal: any;
          try {
            signal = JSON.parse(await readFile(path, "utf8"));
          } catch (error: any) {
            if (error.code === "ENOENT") continue;
            throw error;
          }
          if (
            signal.id !== entry.name.slice(0, -5) ||
            typeof signal.dir !== "string" ||
            !signal.dir ||
            normalizeSource(signal.dir) !== signal.dir
          )
            throw new Error("invalid scheduler activity marker");
          const apply = this.db.transaction(() => {
            const result = this.db
              .prepare("INSERT OR IGNORE INTO processed_signals VALUES (?)")
              .run(signal.id);
            if (result.changes)
              this.db
                .prepare(
                  "INSERT INTO directories VALUES (?,1,0) ON CONFLICT(path) DO UPDATE SET pending=pending+1",
                )
                .run(signal.dir);
          });
          apply();
          try {
            await unlink(path);
          } catch (error: any) {
            if (error.code !== "ENOENT") throw error;
          }
        }
      } finally {
        try {
          await dir.close();
        } catch {}
      }
      if (!this.closed) this.schedule(this.options.debounceMs ?? 30000);
    })()
      .catch((error) => {
        this.retrySignals();
        throw error;
      })
      .finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }
  /** Explicitly settle a paused or interrupted claim after the caller inspects it. */
  resume(): void {
    if (this.closed) throw new Error("scheduler closed");
    const claim = this.acquire();
    if (!claim) throw new Error("project review is active");
    try {
      this.cancelled = false;
      this.db
        .prepare(
          "UPDATE meta SET inflight=0, paused=0, status='pending' WHERE id=1",
        )
        .run();
    } finally {
      this.release(claim);
    }
    this.schedule(0);
  }
  cancel(): void {
    if (this.closed) return;
    this.cancelled = true;
    this.abortWork();
    this.db
      .prepare("UPDATE meta SET paused=1,status='cancelled' WHERE id=1")
      .run();
  }
  private abortWork(): void {
    this.controller?.abort();
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.signalTimer !== undefined) {
      this.clock.clearTimeout(this.signalTimer);
      this.signalTimer = undefined;
    }
  }
  private closeDb(): void {
    if (!this.dbClosed) {
      this.dbClosed = true;
      this.db.close();
    }
  }
  async shutdown(): Promise<{
    status: "closed" | "quarantined" | "activity-unpersisted";
  }> {
    if (this.closed)
      return { status: this.detached ? "quarantined" : "closed" };
    this.closed = true;
    this.abortWork();
    const pending = Promise.allSettled([
      this.persistActivities(),
      this.flushing,
      this.running,
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(
        () => resolve("timeout"),
        this.options.shutdownGraceMs ?? 1000,
      );
    });
    const result = await Promise.race([pending, timeout]);
    if (timer) clearTimeout(timer);
    if (result === "timeout") {
      this.detached = true;
      try {
        this.db
          .prepare(
            "UPDATE meta SET paused=1,status='shutdown-uncertain' WHERE id=1",
          )
          .run();
      } catch {}
      void pending.then(() => this.closeDb());
      return { status: "quarantined" };
    }
    this.closeDb();
    if (
      result.some((entry) => entry.status === "rejected") ||
      this.unwritten.size
    )
      return { status: "activity-unpersisted" };
    return { status: "closed" };
  }
  private schedule(delay: number): void {
    if (this.closed || this.running) return;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    let state: SchedulerStatus;
    try {
      state = this.status();
    } catch {
      this.retrySignals();
      return;
    }
    if (!state.pending || state.paused) {
      this.timer = undefined;
      return;
    }
    const wait = Math.max(delay, state.cooldownUntil - this.clock.now(), 0);
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.running = this.run()
        .catch(() => {
          try {
            const state = this.status();
            this.db
              .prepare("UPDATE meta SET paused=?,status=? WHERE id=1")
              .run(
                state.inflight ? 1 : 0,
                state.inflight ? "interrupted-uncertain" : "error",
              );
            try {
              this.options.onStatus?.(
                state.inflight ? "interrupted-uncertain" : "error",
              );
            } catch {}
          } catch {}
        })
        .finally(() => {
          this.running = undefined;
          if (!this.closed) this.schedule(this.nextDelay);
        });
    }, wait);
  }
  private acquire(): Database.Database | undefined {
    const claim = new Database(this.claimPath, { timeout: 0 });
    try {
      claim.exec("BEGIN IMMEDIATE");
      return claim;
    } catch (error: any) {
      claim.close();
      if (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
        return undefined;
      throw error;
    }
  }
  private release(db: Database.Database): void {
    try {
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  }
  private async run(): Promise<void> {
    this.nextDelay = this.options.retryMs ?? 60000;
    const claim = this.acquire();
    if (!claim) return;
    try {
      const meta = this.db
        .prepare("SELECT paused,inflight,cooldown FROM meta WHERE id=1")
        .get() as any;
      if (meta.paused) return;
      if (meta.inflight) {
        this.db
          .prepare(
            "UPDATE meta SET paused=1, status='interrupted-uncertain' WHERE id=1",
          )
          .run();
        this.options.onStatus?.("interrupted-uncertain");
        return;
      }
      if (this.clock.now() < meta.cooldown) return;
      const item = this.db
        .prepare(
          "SELECT path,pending FROM directories WHERE pending>completed ORDER BY path LIMIT 1",
        )
        .get() as { path: string; pending: number } | undefined;
      if (!item) return;
      this.db
        .prepare("UPDATE meta SET inflight=1,status='running' WHERE id=1")
        .run();
      this.controller = new AbortController();
      let outcome: SchedulerOutcome;
      try {
        outcome = item.path.startsWith(UNSUPPORTED_FILE_SOURCE)
          ? {
              status: "unsupported-session",
              detail:
                "The explicitly opened session filename is not JSONL; activity remains pending.",
            }
          : await this.options.work(item.path, this.controller.signal);
      } catch {
        outcome = {
          status: this.controller.signal.aborted ? "pending" : "error",
        };
      }
      const next = this.clock.now() + (this.options.cooldownMs ?? 300000);
      const settle = this.db.transaction(() => {
        const externallyPaused = !!(
          this.db.prepare("SELECT paused FROM meta WHERE id=1").get() as any
        ).paused;
        if (
          outcome.status === "done" &&
          !this.controller?.signal.aborted &&
          !externallyPaused
        )
          this.db
            .prepare(
              "UPDATE directories SET completed=MAX(completed,?) WHERE path=?",
            )
            .run(item.pending, item.path);
        const pause =
          externallyPaused ||
          this.detached ||
          this.cancelled ||
          outcome.status === "uncertain" ||
          outcome.status === "unresolved";
        this.db
          .prepare(
            "UPDATE meta SET inflight=0,paused=?,status=?,cooldown=? WHERE id=1",
          )
          .run(
            pause ? 1 : 0,
            this.detached
              ? "shutdown-uncertain"
              : this.cancelled || externallyPaused
                ? "cancelled"
                : outcome.status,
            next,
          );
      });
      settle();
      if (outcome.status === "done") this.nextDelay = 0;
      if (!this.closed) this.options.onStatus?.(outcome.status);
    } finally {
      this.controller = undefined;
      this.release(claim);
    }
  }
}

/** Process only bounded batches; mutations and partial branches get a fresh pass. */
export async function reviewProjectSessions(options: {
  project: string;
  sessionDir: string;
  checkpointFile: string;
  reviewer: MemoryReviewer;
  signal: AbortSignal;
  maxPasses?: number;
}): Promise<SchedulerOutcome> {
  const source = new SessionReview({
    project: options.project,
    sessionDir: options.sessionDir,
    checkpointFile: options.checkpointFile,
  });
  const maxPasses = options.maxPasses ?? 24;
  let passes = 0;
  let continuation = false;
  let unavailable = false;
  try {
    do {
      options.signal.throwIfAborted();
      const scan = source.discover({ continue: continuation });
      continuation = scan.continuation;
      unavailable ||= scan.issues.some(
        (issue) =>
          !!issue.path &&
          !/excluded: different project|fork copied history verified|review text budget reached/.test(
            issue.reason,
          ),
      );
      for (const batch of scan.batches) {
        let offset: number | undefined, fullSnapshot: string | undefined;
        while (true) {
          options.signal.throwIfAborted();
          if (++passes > maxPasses) return { status: "pending" };
          const result = await options.reviewer.review({
            batch,
            signal: options.signal,
            fullOffset: offset,
            fullSnapshot,
          });
          if (result.status === "uncertain" || result.status === "unresolved")
            return { status: result.status };
          if (result.status === "applied") {
            offset = undefined;
            fullSnapshot = undefined;
            continue;
          }
          if (result.nextOffset !== undefined) {
            offset = result.nextOffset;
            fullSnapshot = result.fullSnapshot;
            continue;
          }
          if (!result.acknowledged) return { status: "unresolved" };
          if (batch.more) return { status: "pending" };
          break;
        }
      }
    } while (continuation);
    return unavailable
      ? {
          status: "error",
          detail: "Some session sources are incomplete or unavailable.",
        }
      : { status: "done" };
  } finally {
    source.close();
  }
}
