import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { sanitizeUrl } from "./redaction.ts";

export class DownloadCleanupError extends Error {
  constructor(cause?: unknown) {
    super("Download listener cleanup unverified.", { cause });
  }
}
export type DownloadTarget = { sessionId: string; tabId: string };
export type NativeDownload = {
  url(): string;
  suggestedFilename(): string;
  failure(): Promise<string | null>;
  createReadStream(): Promise<Readable | null>;
  cancel(): Promise<void>;
  delete(): Promise<void>;
};
export type DownloadPage = {
  on(event: "download", listener: (download: NativeDownload) => void): unknown;
  off(event: "download", listener: (download: NativeDownload) => void): unknown;
};
export type DownloadArtifact = {
  id: string;
  path: string;
  bytes: number;
  expiresAt: number;
  lockWarning?: string;
};
/** The sink must enforce the shared artifact quota atomically, stage privately, and
 * publish without overwriting. It must consume the stream before returning, roll
 * back on errors/abort before the publication commit point. Once committed it
 * must return the artifact even if cancellation races with publication. It owns retention/export. */
export type BinaryArtifactSink = {
  putBinary(
    owner: string,
    data: AsyncIterable<Uint8Array>,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<DownloadArtifact>;
};
export type DownloadRecord = DownloadTarget & {
  id: string;
  url: string;
  suggestedName: string;
  state: "pending" | "saving" | "complete" | "failed" | "cancelled" | "unknown";
  failure?: string;
  cleanupWarning?: string;
  artifact?: DownloadArtifact;
};
const LIMIT_NOTICE =
  "The size limit applies to retained files, not browser/network temporary bytes. Admission is subject to per-owner and total record limits; rejectionReasons reports saturation. Closed-session reports expire from bounded history.";
const terminal = (state: DownloadRecord["state"]) =>
  state === "complete" ||
  state === "failed" ||
  state === "cancelled" ||
  state === "unknown";
const cleanName = (name: string) =>
  name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 255) || "download";
const errorText = (error: unknown) =>
  String(error instanceof Error ? error.message : error).slice(0, 500);

class DeadlineError extends Error {}
async function deadline<T>(
  label: string,
  operation: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw new Error("Download cancelled.");
        return operation();
      }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Download cancelled."));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DeadlineError(`${label} timed out; outcome unverified.`),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

type Entry = {
  record: DownloadRecord;
  native: NativeDownload;
  controller: AbortController;
  done: Promise<void>;
  waiters: Set<() => void>;
  settled: boolean;
  owner: string;
  cancelling?: Promise<void>;
};
type CloseReport = { cleanup: "complete" | "unverified"; warnings: number };
type RejectionReason = "activeLimit" | "ownerLimit" | "totalLimit";
type Counters = {
  rejected: number;
  evicted: number;
  cleanupWarnings: number;
  rejectionReasons: Record<RejectionReason, number>;
};
type ClosedSession = { owner: string; report: CloseReport; counters: Counters };

/** Page-scoped, opt-in capture. Close a session before closing its context. */
export class DownloadManager {
  readonly notice = LIMIT_NOTICE;
  private pages = new Map<
    DownloadPage,
    {
      target: DownloadTarget;
      listener: (download: NativeDownload) => void;
      deactivate: () => void;
      protectHandoffDownloads: () => void;
    }
  >();
  private entries = new Map<string, Entry>();
  private suspended = new Map<
    string,
    {
      owner: string;
      ignored: number;
      inFlightBefore: number;
      pendingCleanup: number;
    }
  >();
  private active = 0;
  private waiting = 0;
  private endings = new Map<string, Promise<CloseReport>>();
  private closeReports = new Map<string, ClosedSession>();
  private rejected = new Map<string, number>();
  private evicted = new Map<string, number>();
  private warnings = new Map<string, number>();
  private rejectionReasons = new Map<string, Record<RejectionReason, number>>();
  private rejectedWork = new Map<string, Set<Promise<void>>>();
  private closed = false;
  private readonly sink: BinaryArtifactSink;
  private readonly maxBytes: number;
  private readonly maxActive: number;
  private readonly maxRecords: number;
  private readonly maxTotalRecords: number;
  private readonly maxSessions: number;
  private readonly maxPages: number;
  private readonly maxClosedSessions: number;
  private readonly maxWaiters: number;
  private readonly operationTimeoutMs: number;
  private readonly onOverflow?: (sessionId: string) => void;
  private readonly owners = new Map<string, string>();
  constructor(options: {
    sink: BinaryArtifactSink;
    maxBytes?: number;
    maxActive?: number;
    /** Maximum records per creating Pi owner. */
    maxRecords?: number;
    maxTotalRecords?: number;
    maxSessions?: number;
    maxPages?: number;
    maxClosedSessions?: number;
    maxWaiters?: number;
    operationTimeoutMs?: number;
    onOverflow?: (sessionId: string) => void;
  }) {
    this.sink = options.sink;
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    this.maxActive = options.maxActive ?? 4;
    this.maxRecords = options.maxRecords ?? 100;
    this.maxTotalRecords = options.maxTotalRecords ?? 1000;
    this.maxSessions = options.maxSessions ?? 256;
    this.maxPages = options.maxPages ?? 1024;
    this.maxClosedSessions = options.maxClosedSessions ?? 100;
    this.maxWaiters = options.maxWaiters ?? 50;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 30000;
    this.onOverflow = options.onOverflow;
    for (const value of [
      this.maxBytes,
      this.maxActive,
      this.maxRecords,
      this.maxTotalRecords,
      this.maxSessions,
      this.maxPages,
      this.maxClosedSessions,
      this.maxWaiters,
      this.operationTimeoutMs,
    ])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Invalid download limit.");
  }
  attach(target: DownloadTarget, page: DownloadPage, owner = target.sessionId) {
    if (
      this.closed ||
      this.endings.has(target.sessionId) ||
      this.closeReports.has(target.sessionId)
    )
      throw new Error("Download session closed.");
    if (this.pages.has(page)) throw new Error("Page already subscribed.");
    if (this.pages.size >= this.maxPages)
      throw new Error("Download page capacity exceeded.");
    const existingOwner = this.owners.get(target.sessionId);
    if (existingOwner === undefined && this.owners.size >= this.maxSessions)
      throw new Error("Download session capacity exceeded.");
    if (existingOwner !== undefined && existingOwner !== owner)
      throw new Error("Download session owner mismatch.");
    this.owners.set(target.sessionId, owner);
    const scope = { ...target };
    let active = true;
    let handoffProtected = this.suspended.has(target.sessionId);
    const listener = (download: NativeDownload) => {
      const suspension = this.suspended.get(scope.sessionId);
      if (suspension) {
        suspension.ignored = Math.min(
          Number.MAX_SAFE_INTEGER,
          suspension.ignored + 1,
        );
        return;
      }
      if (!active && handoffProtected) return;
      if (!active) {
        // A queued callback from a detached page must never recreate session state.
        void deadline(
          "Stale download cancellation",
          () => download.cancel(),
          this.operationTimeoutMs,
        )
          .catch(() => {})
          .then(() =>
            deadline(
              "Stale download deletion",
              () => download.delete(),
              this.operationTimeoutMs,
            ),
          )
          .catch(() => {});
        return;
      }
      this.capture(scope, owner, download);
    };
    this.pages.set(page, {
      target: scope,
      listener,
      deactivate: () => {
        active = false;
      },
      protectHandoffDownloads: () => {
        handoffProtected = true;
      },
    });
    try {
      page.on("download", listener);
    } catch (error) {
      active = false;
      let cleanupError: unknown;
      try {
        page.off("download", listener);
      } catch (failure) {
        cleanupError = failure;
      }
      this.pages.delete(page);
      if (existingOwner === undefined) this.owners.delete(target.sessionId);
      if (cleanupError) throw new DownloadCleanupError(cleanupError);
      throw error;
    }
  }
  detach(target: DownloadTarget, onlyPage?: DownloadPage) {
    let failed = false;
    for (const [page, entry] of this.pages) {
      if (
        entry.target.sessionId === target.sessionId &&
        entry.target.tabId === target.tabId &&
        (!onlyPage || page === onlyPage)
      ) {
        entry.deactivate();
        try {
          page.off("download", entry.listener);
        } catch {
          failed = true;
        }
        this.pages.delete(page);
      }
    }
    if (failed) {
      this.warn(target.sessionId);
      throw new DownloadCleanupError();
    }
  }
  /** Suspend capture without cancelling, reading, deleting or retaining human downloads. */
  suspendSession(sessionId: string, owner: string) {
    if (this.closed || this.owners.get(sessionId) !== owner)
      throw new Error("Download capture cannot be suspended for this session.");
    const prior = this.suspended.get(sessionId);
    if (prior)
      return {
        inFlightBefore: prior.inFlightBefore,
        pendingCleanup: prior.pendingCleanup,
      };
    const inFlightBefore = [...this.entries.values()].filter(
      (entry) => entry.record.sessionId === sessionId && !entry.settled,
    ).length;
    const pendingCleanup = this.rejectedWork.get(sessionId)?.size ?? 0;
    this.suspended.set(sessionId, {
      owner,
      ignored: 0,
      inFlightBefore,
      pendingCleanup,
    });
    for (const page of this.pages.values())
      if (page.target.sessionId === sessionId) page.protectHandoffDownloads();
    return { inFlightBefore, pendingCleanup };
  }

  captureStatus(sessionId: string, owner: string) {
    if (!this.owns(sessionId, owner))
      throw new Error(
        "Download session unavailable or owned by another Pi session.",
      );
    const suspension = this.suspended.get(sessionId);
    return {
      state: this.closeReports.has(sessionId)
        ? "closed"
        : suspension
          ? "suspended"
          : "enabled",
      ...(suspension
        ? {
            ignored: suspension.ignored,
            inFlightBefore: suspension.inFlightBefore,
          }
        : {}),
      warning:
        "After capture is explicitly resumed, delayed downloads initiated by a human during handoff may be saved as agent artifacts. Playwright downloads are browser-managed temporary files, not automatically saved to a user-chosen path.",
    };
  }

  suspensionStatus(sessionId: string, owner: string) {
    const suspension = this.suspended.get(sessionId);
    if (!suspension || suspension.owner !== owner)
      throw new Error("Download suspension unavailable for this owner.");
    return {
      ignored: suspension.ignored,
      inFlightBefore: suspension.inFlightBefore,
      captureRestored: false as const,
    };
  }

  resumeSession(sessionId: string, owner: string) {
    const suspension = this.suspended.get(sessionId);
    if (!suspension || suspension.owner !== owner)
      throw new Error("Download suspension unavailable for this owner.");
    this.suspended.delete(sessionId);
    return {
      ignored: suspension.ignored,
      inFlightBefore: suspension.inFlightBefore,
    };
  }

  private notify(entry: Entry) {
    for (const wake of entry.waiters) wake();
  }
  markCleanupUnverified(sessionId: string): void {
    this.warn(sessionId);
  }
  private warn(sessionId: string) {
    const closed = this.closeReports.get(sessionId);
    if (closed) {
      closed.report.cleanup = "unverified";
      closed.report.warnings = Math.min(
        Number.MAX_SAFE_INTEGER,
        closed.report.warnings + 1,
      );
      closed.counters.cleanupWarnings = closed.report.warnings;
      return;
    }
    if (!this.owners.has(sessionId)) return;
    this.warnings.set(
      sessionId,
      Math.min(
        Number.MAX_SAFE_INTEGER,
        (this.warnings.get(sessionId) ?? 0) + 1,
      ),
    );
  }
  private async cleanupNative(
    native: NativeDownload,
    sessionId: string,
    cancel: boolean,
  ): Promise<string | undefined> {
    const errors: string[] = [];
    if (cancel)
      try {
        await deadline(
          "Download cancellation",
          () => native.cancel(),
          this.operationTimeoutMs,
        );
      } catch (error) {
        errors.push(errorText(error));
      }
    try {
      await deadline(
        "Download deletion",
        () => native.delete(),
        this.operationTimeoutMs,
      );
    } catch (error) {
      errors.push(errorText(error));
    }
    if (errors.length) {
      this.warn(sessionId);
      return errors.join("; ");
    }
    return undefined;
  }
  private rejectNative(sessionId: string, native: NativeDownload) {
    const set = this.rejectedWork.get(sessionId) ?? new Set<Promise<void>>();
    this.rejectedWork.set(sessionId, set);
    if (set.size >= this.maxRecords) {
      // Do not retain unbounded work during an event flood. The session report
      // explicitly marks cleanup unverified, and the owned context must close.
      this.warn(sessionId);
      try {
        this.onOverflow?.(sessionId);
      } catch {
        /* cleanup remains unverified */
      }
      void Promise.resolve()
        .then(() => native.cancel())
        .catch(() => {})
        .then(() => native.delete())
        .catch(() => {});
      return;
    }
    const work = this.cleanupNative(native, sessionId, true).then(() => {});
    set.add(work);
    void work.finally(() => {
      set.delete(work);
      if (!set.size && this.rejectedWork.get(sessionId) === set)
        this.rejectedWork.delete(sessionId);
    });
  }
  private evictOne(owner: string) {
    for (const [id, entry] of this.entries) {
      if (entry.owner === owner && entry.settled && entry.waiters.size === 0) {
        this.entries.delete(id);
        const sessionId = entry.record.sessionId;
        this.evicted.set(
          sessionId,
          Math.min(
            Number.MAX_SAFE_INTEGER,
            (this.evicted.get(sessionId) ?? 0) + 1,
          ),
        );
        return true;
      }
    }
    return false;
  }
  private capture(
    target: DownloadTarget,
    owner: string,
    native: NativeDownload,
  ) {
    if (this.closed || this.endings.has(target.sessionId)) {
      this.rejectNative(target.sessionId, native);
      return;
    }
    // Limits are per owner and total. Never evict another owner's record.
    let ownerCount = [...this.entries.values()].filter(
      (entry) => entry.owner === owner,
    ).length;
    if (
      this.active < this.maxActive &&
      (ownerCount >= this.maxRecords ||
        this.entries.size >= this.maxTotalRecords) &&
      this.evictOne(owner)
    )
      ownerCount--;
    const reason: RejectionReason | undefined =
      this.active >= this.maxActive
        ? "activeLimit"
        : ownerCount >= this.maxRecords
          ? "ownerLimit"
          : this.entries.size >= this.maxTotalRecords
            ? "totalLimit"
            : undefined;
    if (reason) {
      const reasons = this.rejectionReasons.get(target.sessionId) ?? {
        activeLimit: 0,
        ownerLimit: 0,
        totalLimit: 0,
      };
      reasons[reason] = Math.min(Number.MAX_SAFE_INTEGER, reasons[reason] + 1);
      this.rejectionReasons.set(target.sessionId, reasons);
      this.rejected.set(
        target.sessionId,
        Math.min(
          Number.MAX_SAFE_INTEGER,
          (this.rejected.get(target.sessionId) ?? 0) + 1,
        ),
      );
      this.rejectNative(target.sessionId, native);
      return;
    }
    const id = randomUUID();
    const record: DownloadRecord = {
      ...target,
      id,
      url: sanitizeUrl(native.url()).slice(0, 4096),
      suggestedName: cleanName(native.suggestedFilename()),
      state: "pending",
    };
    const entry: Entry = {
      record,
      native,
      controller: new AbortController(),
      done: Promise.resolve(),
      waiters: new Set(),
      settled: false,
      owner,
    };
    this.entries.set(id, entry);
    this.active++;
    entry.done = this.save(entry).finally(() => {
      this.active--;
      entry.settled = true;
      this.notify(entry);
    });
  }
  private async save(entry: Entry) {
    const { record, native, controller } = entry;
    try {
      const failure = await deadline(
        "Download completion",
        () => native.failure(),
        this.operationTimeoutMs,
        controller.signal,
      );
      if (controller.signal.aborted) throw new Error("Download cancelled.");
      if (failure) throw new Error("Browser download failed.");
      const stream = await deadline(
        "Download stream",
        () =>
          native.createReadStream().then((stream) => {
            if (controller.signal.aborted) stream?.destroy();
            return stream;
          }),
        this.operationTimeoutMs,
        controller.signal,
      );
      if (!stream) throw new Error("Download stream unavailable.");
      if (controller.signal.aborted) {
        stream.destroy();
        throw new Error("Download cancelled.");
      }
      const stopStream = () => stream.destroy();
      controller.signal.addEventListener("abort", stopStream, { once: true });
      record.state = "saving";
      this.notify(entry);
      const max = this.maxBytes;
      const bounded = async function* () {
        let bytes = 0;
        try {
          for await (const chunk of stream) {
            if (controller.signal.aborted)
              throw new Error("Download cancelled.");
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > max)
              throw new Error("Download exceeds retained-file size limit.");
            yield buffer;
          }
        } finally {
          controller.signal.removeEventListener("abort", stopStream);
          stream.destroy();
        }
      };
      let artifact: DownloadArtifact;
      try {
        artifact = await deadline(
          "Artifact save",
          () =>
            this.sink.putBinary(entry.owner, bounded(), {
              maxBytes: max,
              signal: controller.signal,
            }),
          this.operationTimeoutMs,
        );
      } finally {
        controller.signal.removeEventListener("abort", stopStream);
        stream.destroy();
      }
      // Sink contract guarantees abort cannot publish; a successful publication must
      // remain visible even if cancellation races immediately after its return.
      record.artifact = artifact;
      record.state = "complete";
    } catch (error) {
      const uncertainSave =
        error instanceof DeadlineError && record.state === "saving";
      if (error instanceof DeadlineError) {
        controller.abort();
        this.warn(record.sessionId);
        await this.cancelEntry(entry);
      }
      record.state = uncertainSave
        ? "unknown"
        : controller.signal.aborted && !(error instanceof DeadlineError)
          ? "cancelled"
          : "failed";
      record.failure = errorText(error);
      if (uncertainSave)
        record.failure +=
          " Artifact publication may have occurred; do not retry without inspection.";
    } finally {
      if (entry.cancelling) await entry.cancelling;
      const warning = await this.cleanupNative(native, record.sessionId, false);
      if (warning)
        record.cleanupWarning = [record.cleanupWarning, warning]
          .filter(Boolean)
          .join("; ");
    }
  }
  private get(sessionId: string, id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.record.sessionId !== sessionId)
      throw new Error("Download unavailable or owned by another session.");
    return entry;
  }
  owns(sessionId: string, owner: string): boolean {
    return (
      (this.owners.get(sessionId) ??
        this.closeReports.get(sessionId)?.owner) === owner
    );
  }
  list(sessionId: string): DownloadRecord[] {
    return [...this.entries.values()]
      .filter((e) => e.record.sessionId === sessionId)
      .map((e) => structuredClone(e.record));
  }
  /** Counts events refused for saturation without retaining per-download metadata. */
  saturation(sessionId: string) {
    const closed = this.closeReports.get(sessionId);
    return {
      rejected: closed?.counters.rejected ?? this.rejected.get(sessionId) ?? 0,
      evicted: closed?.counters.evicted ?? this.evicted.get(sessionId) ?? 0,
      cleanupWarnings:
        closed?.counters.cleanupWarnings ?? this.warnings.get(sessionId) ?? 0,
      rejectionReasons: {
        ...(closed?.counters.rejectionReasons ??
          this.rejectionReasons.get(sessionId) ?? {
            activeLimit: 0,
            ownerLimit: 0,
            totalLimit: 0,
          }),
      },
      closedCleanup: closed ? { ...closed.report } : null,
    };
  }
  inspect(sessionId: string, id: string): DownloadRecord {
    return structuredClone(this.get(sessionId, id).record);
  }
  async wait(
    sessionId: string,
    id: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<DownloadRecord> {
    const entry = this.get(sessionId, id);
    const timeout = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 300000)
      throw new Error("Invalid download wait timeout.");
    if (options.signal?.aborted) throw new Error("Download wait cancelled.");
    if (entry.settled) return structuredClone(entry.record);
    if (this.waiting >= this.maxWaiters)
      throw new Error("Download waiter limit exceeded.");
    this.waiting++;
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          entry.waiters.delete(wake);
          options.signal?.removeEventListener("abort", abort);
        };
        const wake = () => {
          if (entry.settled) {
            cleanup();
            resolve();
          }
        };
        const abort = () => {
          cleanup();
          reject(new Error("Download wait cancelled."));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Download wait timed out."));
        }, timeout);
        entry.waiters.add(wake);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        else wake();
      });
      return structuredClone(entry.record);
    } finally {
      this.waiting--;
    }
  }
  private cancelEntry(entry: Entry) {
    if (entry.cancelling) return entry.cancelling;
    entry.controller.abort();
    entry.cancelling = deadline(
      "Download cancellation",
      () => entry.native.cancel(),
      this.operationTimeoutMs,
    ).catch((error) => {
      entry.record.cleanupWarning = errorText(error);
      this.warn(entry.record.sessionId);
    });
    return entry.cancelling;
  }
  async cancel(sessionId: string, id: string) {
    const entry = this.get(sessionId, id);
    if (!terminal(entry.record.state)) await this.cancelEntry(entry);
    await entry.done;
    return structuredClone(entry.record);
  }
  endSession(sessionId: string): Promise<CloseReport> {
    const existing = this.endings.get(sessionId);
    if (existing) return existing;
    const closed = this.closeReports.get(sessionId);
    if (closed) return Promise.resolve({ ...closed.report });
    const owner = this.owners.get(sessionId);
    if (owner === undefined)
      return Promise.resolve({ cleanup: "unverified", warnings: 1 });
    for (const { target } of [...this.pages.values()])
      if (target.sessionId === sessionId) {
        try {
          this.detach(target);
        } catch {
          /* failure recorded by detach */
        }
      }
    this.suspended.delete(sessionId);
    const entries = [...this.entries.values()].filter(
      (e) => e.record.sessionId === sessionId,
    );
    const ending = (async () => {
      await Promise.all(
        entries.map(async (entry) => {
          if (!terminal(entry.record.state)) await this.cancelEntry(entry);
          await entry.done;
        }),
      );
      await Promise.all([...(this.rejectedWork.get(sessionId) ?? [])]);
      for (const entry of entries) this.entries.delete(entry.record.id);
      const warnings = this.warnings.get(sessionId) ?? 0;
      const report = {
        cleanup: warnings ? ("unverified" as const) : ("complete" as const),
        warnings,
      };
      const counters: Counters = {
        rejected: this.rejected.get(sessionId) ?? 0,
        evicted: this.evicted.get(sessionId) ?? 0,
        cleanupWarnings: warnings,
        rejectionReasons: this.rejectionReasons.get(sessionId) ?? {
          activeLimit: 0,
          ownerLimit: 0,
          totalLimit: 0,
        },
      };
      this.closeReports.set(sessionId, { owner, report, counters });
      while (this.closeReports.size > this.maxClosedSessions)
        this.closeReports.delete(this.closeReports.keys().next().value!);
      this.owners.delete(sessionId);
      this.rejected.delete(sessionId);
      this.evicted.delete(sessionId);
      this.warnings.delete(sessionId);
      this.rejectionReasons.delete(sessionId);
      this.rejectedWork.delete(sessionId);
      return { ...report };
    })();
    this.endings.set(sessionId, ending);
    void ending
      .finally(() => {
        if (this.endings.get(sessionId) === ending)
          this.endings.delete(sessionId);
      })
      .catch(() => {});
    return ending;
  }
  async shutdown() {
    this.closed = true;
    const sessions = new Set(
      [...this.pages.values()]
        .map((e) => e.target.sessionId)
        .concat([...this.entries.values()].map((e) => e.record.sessionId))
        .concat(
          [...this.endings.keys()],
          [...this.rejectedWork.keys()],
          [...this.owners.keys()],
        ),
    );
    return Promise.all([...sessions].map((id) => this.endSession(id)));
  }
}
