import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Dialog,
  Page,
  Request,
} from "playwright";
import { acquireProfile, type ProfileLease } from "./profiles.ts";
import {
  DiagnosticCleanupError,
  type BrowserDiagnostics,
} from "./diagnostics.ts";
import { DownloadCleanupError, type DownloadManager } from "./downloads.ts";
import type { TraceRecordings } from "./recording.ts";
import type { VideoRecordings } from "./video-recording.ts";
import { SemanticSnapshots } from "./semantic-snapshots.ts";
import { pickHumanElement } from "./human-picker.ts";
import { sanitizeUrl } from "./redaction.ts";
import {
  captureScreenshot,
  setScreenshotViewport,
  type ScreenshotLimits,
  type ViewportChoice,
} from "./screenshots.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { AttachedPage } from "./attachment-page.ts";
import {
  discoverAttachmentEndpoint,
  validateAttachmentEndpoint,
} from "./attachment-endpoint.ts";

function presentedPageUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:")
      return sanitizeUrl(value);
    if (value === "about:blank") return value;
    return "[non-HTTP URL omitted]";
  } catch {
    return "[invalid URL]";
  }
}

function navigationError(error: unknown, signal?: AbortSignal): Error {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  const safeMessages = new Set([
    "Browser runtime is shut down.",
    "Browser operation cancelled before dispatch.",
    "Session is awaiting human confirmation; automated page work is paused.",
    "A browser dialog is pending; resolve it explicitly before other operations.",
    "Session is busy; retry after its current operation finishes.",
    "Session closed during operation; an already dispatched action may have occurred.",
    "Browser operation cancelled; owned session cleanup was requested but may be incomplete. An already dispatched action may have occurred.",
  ]);
  if (safeMessages.has(message)) return new Error(message);
  const kind =
    signal?.aborted || name === "AbortError"
      ? "cancelled"
      : name === "TimeoutError" ||
          /^page\.goto: Timeout \d+ms exceeded/.test(message)
        ? "timed out"
        : /^page\.goto: net::ERR_[A-Z_]+/.test(message)
          ? "failed due to a network error"
          : "failed";
  return new Error(
    `Navigation ${kind}; it may have started. No retry was made.`,
  );
}

export type BrowserAction = {
  action: "click" | "fill" | "select" | "press" | "scroll" | "wait";
  target:
    | { ref: string }
    | { selector: string; frameSelector?: string; scopeSelector?: string }
    | {
        role: string;
        name: string;
        frameSelector?: string;
        scopeSelector?: string;
      };
  value?: string;
  timeoutMs?: number;
  expect?: {
    kind: "text" | "url" | "response";
    value: string;
    status?: number;
  };
};

export type DialogPendingResult = {
  target: SessionTarget;
  status: "awaiting_dialog";
  operationId: string;
  dialog: { id: string; type: string; message: string; defaultValue: string };
  note: string;
};

export type SessionPurpose = "development" | "research";
export type SessionTarget = { sessionId: string; tabId: string };
export type SessionSummary = {
  sessionId: string;
  purpose: SessionPurpose;
  headless: boolean;
  tabs: { tabId: string; url: string }[];
};
export type BrowserLauncher = (options: {
  headless: boolean;
}) => Promise<Browser>;

type Session = {
  id: string;
  browser: Browser;
  context: BrowserContext;
  pages: Map<string, Page>;
  purpose: SessionPurpose;
  headless: boolean;
  profile?: string;
  restartRequest?: { id: string; target: SessionTarget };
  closed: boolean;
  busy: boolean;
  artifactOwner: string;
  video: boolean;
  disposing?: Promise<void>;
  picker?: {
    id: string;
    target: SessionTarget;
    finish: AbortController;
    cancel: AbortController;
  };
  handoff?: {
    id: string;
    target: SessionTarget;
    targetLost: boolean;
    downloads?: { inFlightBefore: number; pendingCleanup: number };
  };
  handoffDiagnosticsGap?: boolean;
  handoffDownloadsGap?: {
    ignored: number;
    inFlightBefore: number;
    captureRestored: boolean;
  };
  dialog?: {
    id: string;
    page: Page;
    target: SessionTarget;
    dialog: Dialog;
    operationId?: string;
    resolving: boolean;
    timer: ReturnType<typeof setTimeout>;
  };
  operation?: {
    id: string;
    notify: (value: unknown) => void;
    finishClose?: () => void;
    result?: unknown;
    settled: boolean;
  };
};

const dialogMessageDigest = (message: string) =>
  createHash("sha256").update(message).digest("hex");

type AttachedSession = {
  id: string;
  owner: string;
  origin: string;
  page?: AttachedPage;
  diagnosticsEnabled: boolean;
  stop: AbortController;
  busy: boolean;
  targetId?: string;
  discovered: Set<string>;
};

async function listLocalPageTargets(
  origin: string,
  signal: AbortSignal,
): Promise<{ ids: string[]; omitted: number }> {
  const base = validateAttachmentEndpoint(origin, "http:");
  if (base.pathname !== "/" || base.search)
    throw new Error("Attachment endpoint must be an origin.");
  await discoverAttachmentEndpoint(origin, { signal, timeoutMs: 5000 });
  if (signal.aborted) throw new Error("Attachment discovery cancelled.");
  const body = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const req = httpRequest(
      {
        hostname: base.hostname.replace(/^\[|\]$/g, ""),
        port: base.port,
        path: "/json/list",
        method: "GET",
        headers: { host: base.host },
        agent: false,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          finish(
            new Error(
              "Target discovery rejected a non-200 response or redirect.",
            ),
          );
          return;
        }
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 262144) {
            res.destroy();
            finish(new Error("Target discovery response exceeds the limit."));
          } else chunks.push(chunk);
        });
        res.on("end", () => finish());
        res.on("error", () =>
          finish(new Error("Target discovery response failed.")),
        );
        res.on("aborted", () =>
          finish(new Error("Target discovery response interrupted.")),
        );
      },
    );
    const abort = () => {
      req.destroy();
      finish(new Error("Target discovery cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
    req.on("error", () =>
      finish(new Error("Target discovery connection failed.")),
    );
    if (signal.aborted) abort();
    else req.end();
  });
  let list: unknown;
  try {
    list = JSON.parse(body);
  } catch {
    throw new Error("Invalid target discovery response.");
  }
  if (!Array.isArray(list))
    throw new Error("Invalid target discovery response.");
  const ids = [
    ...new Set(
      list
        .filter(
          (item) =>
            item &&
            item.type === "page" &&
            typeof item.id === "string" &&
            /^[A-Za-z0-9_-]{1,128}$/.test(item.id),
        )
        .map((item) => item.id as string),
    ),
  ];
  return { ids: ids.slice(0, 100), omitted: Math.max(0, ids.length - 100) };
}

type DialogMonitor = {
  live: boolean;
  trusted: boolean;
  epoch: number;
  cdp?: CDPSession;
  observed: { id: string; type: string; message: string; epoch: number }[];
  openings: {
    frameId: string;
    type: string;
    message: string;
    epoch: number;
    dialogId?: string;
    closed?: boolean;
    result?: boolean;
  }[];
  onFrame: () => void;
  onDisconnect: () => void;
};

/** Owns disposable and explicitly named persistent browsers, never personal profiles. */
export class ManagedSessions {
  private sessions = new Map<string, Session>();
  private restartResults = new Map<
    string,
    {
      owner: string;
      status: "restarting" | "ready" | "failed";
      target?: SessionTarget;
      handoffId?: string;
      message?: string;
    }
  >();
  private attachments = new Map<string, AttachedSession>();
  private readonly attachmentStop = new AbortController();
  private readonly attachmentLockRoot?: string;
  private snapshots = new Map<Page, SemanticSnapshots>();
  private dialogMonitors = new Map<Page, DialogMonitor>();
  private actionHooks = new Set<
    (info: {
      page: Page;
      target: SessionTarget;
      action: BrowserAction["action"];
    }) => void | (() => void)
  >();
  private readonly makeSnapshots: (page: Page) => SemanticSnapshots;
  private readonly picker: typeof pickHumanElement;
  private selected = new Map<string | undefined, SessionTarget>();
  private provenance = new WeakMap<
    Page,
    {
      epoch: number;
      navigations: number;
      requests: Request[];
      current?: {
        requestedUrl: string;
        loaderId: string;
        url: string;
        epoch: number;
      };
    }
  >();
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private owned = new Map<
    Browser,
    {
      closing?: Promise<void>;
      close: () => Promise<void>;
      lease?: ProfileLease;
      poisoned: boolean;
      closeDispatched: boolean;
    }
  >();
  private disposals = new Map<Browser, Promise<void>>();
  private cleanupFailed = false;
  private attachmentCleanupUnverified = false;
  private launchCleanupUnverified = false;
  private readonly launch: BrowserLauncher;
  private readonly id: () => string;
  private readonly launchPersistent?: (
    path: string,
    options: { headless: boolean; recordVideo?: { dir: string } },
  ) => Promise<BrowserContext>;
  private readonly profileRoot?: string;
  private readonly profileWaitMs: number;
  private readonly acquire: typeof acquireProfile;
  private readonly diagnostics?: BrowserDiagnostics;
  private readonly downloads?: DownloadManager;
  private readonly downloadCloseTimeoutMs: number;
  private readonly recordings?: TraceRecordings;
  private readonly videos?: VideoRecordings;

  constructor(options: {
    launch: BrowserLauncher;
    id?: () => string;
    launchPersistent?: (
      path: string,
      options: { headless: boolean; recordVideo?: { dir: string } },
    ) => Promise<BrowserContext>;
    profileRoot?: string;
    profileWaitMs?: number;
    acquireProfile?: typeof acquireProfile;
    diagnostics?: BrowserDiagnostics;
    downloads?: DownloadManager;
    downloadCloseTimeoutMs?: number;
    recordings?: TraceRecordings;
    videos?: VideoRecordings;
    makeSnapshots?: (page: Page) => SemanticSnapshots;
    picker?: typeof pickHumanElement;
    // Injection is for isolated tests; normal runtimes share the core's private lock root.
    attachmentLockRoot?: string;
  }) {
    this.attachmentLockRoot = options.attachmentLockRoot;
    this.makeSnapshots =
      options.makeSnapshots ?? ((page) => new SemanticSnapshots(page));
    this.picker = options.picker ?? pickHumanElement;
    this.launch = options.launch;
    this.id = options.id ?? randomUUID;
    this.launchPersistent = options.launchPersistent;
    this.profileRoot = options.profileRoot;
    this.profileWaitMs = options.profileWaitMs ?? 30000;
    this.acquire = options.acquireProfile ?? acquireProfile;
    this.diagnostics = options.diagnostics;
    this.downloads = options.downloads;
    this.downloadCloseTimeoutMs = options.downloadCloseTimeoutMs ?? 5000;
    this.recordings = options.recordings;
    this.videos = options.videos;
  }

  private check(signal?: AbortSignal): void {
    if (this.closed) throw new Error("Browser runtime is shut down.");
    if (signal?.aborted)
      throw new Error("Browser operation cancelled before dispatch.");
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }

  private invalidate(session: Session): boolean {
    session.closed = true;
    session.picker?.cancel.abort();
    if (session.dialog) clearTimeout(session.dialog.timer);
    session.dialog = undefined;
    for (const page of session.pages.values()) {
      this.dropSnapshots(page);
      this.unmonitorDialog(page);
    }
    let failed = false;
    try {
      this.diagnostics?.endSession(session.id);
    } catch {
      failed = true;
      this.cleanupFailed = true;
    }
    this.sessions.delete(session.id);
    for (const [owner, target] of this.selected)
      if (target.sessionId === session.id) this.selected.delete(owner);
    return failed;
  }

  private dropSnapshots(page: Page): void {
    const snapshots = this.snapshots.get(page);
    this.snapshots.delete(page);
    if (snapshots) this.track(snapshots.dispose()).catch(() => {});
  }

  private unmonitorDialog(page: Page): void {
    const monitor = this.dialogMonitors.get(page);
    if (!monitor) return;
    this.dialogMonitors.delete(page);
    monitor.live = false;
    monitor.trusted = false;
    try {
      page.off("framenavigated", monitor.onFrame);
      page.off("frameattached", monitor.onFrame);
      page.off("framedetached", monitor.onFrame);
    } catch {
      /* Browser closure is the final cleanup. */
    }
    if (monitor.cdp) {
      monitor.cdp.off("Disconnected", monitor.onDisconnect);
      void monitor.cdp.detach().catch(() => {});
    }
  }

  private reconcileDialogs(
    session: Session,
    page: Page,
    monitor: DialogMonitor,
  ): void {
    if (!monitor.live || !monitor.trusted) return;
    while (
      monitor.observed.length &&
      monitor.openings.some((item) => !item.dialogId)
    ) {
      const observed = monitor.observed.shift()!;
      const opening = monitor.openings.find((item) => !item.dialogId)!;
      if (
        observed.type !== opening.type ||
        observed.message !== opening.message ||
        observed.epoch !== opening.epoch
      ) {
        monitor.trusted = false;
        return;
      }
      opening.dialogId = observed.id;
    }
    while (monitor.openings[0]?.closed && monitor.openings[0].dialogId) {
      const closed = monitor.openings.shift()!;
      const pending = session.dialog;
      if (pending?.page === page && pending.id === closed.dialogId) {
        clearTimeout(pending.timer);
        if (
          pending.dialog.type() === "beforeunload" &&
          closed.result === false &&
          session.operation?.id === pending.operationId
        )
          session.operation.finishClose?.();
        session.dialog = undefined;
      }
    }
  }

  private async monitorDialogs(session: Session, page: Page): Promise<void> {
    const monitor: DialogMonitor = {
      live: false,
      trusted: true,
      epoch: 0,
      observed: [],
      openings: [],
      onFrame: () => {
        monitor.epoch++;
        if (
          monitor.observed.length ||
          monitor.openings.length ||
          session.dialog?.page === page
        )
          monitor.trusted = false;
      },
      onDisconnect: () => {
        monitor.live = false;
        monitor.trusted = false;
      },
    };
    this.dialogMonitors.set(page, monitor);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      page.on("framenavigated", monitor.onFrame);
      page.on("frameattached", monitor.onFrame);
      page.on("framedetached", monitor.onFrame);
      let expired = false;
      const setup = (async () => {
        const cdp = await page.context().newCDPSession(page);
        if (
          expired ||
          this.dialogMonitors.get(page) !== monitor ||
          session.closed
        ) {
          await cdp.detach().catch(() => {});
          return;
        }
        monitor.cdp = cdp;
        cdp.on("Disconnected", monitor.onDisconnect);
        cdp.on("Page.javascriptDialogOpening", (event) => {
          if (!monitor.live || !monitor.trusted) {
            monitor.trusted = false;
            return;
          }
          monitor.openings.push({
            frameId: event.frameId,
            type: event.type,
            message: dialogMessageDigest(event.message),
            epoch: monitor.epoch,
          });
          if (monitor.openings.length > 16) {
            monitor.trusted = false;
            return;
          }
          this.reconcileDialogs(session, page, monitor);
        });
        cdp.on("Page.javascriptDialogClosed", (event) => {
          if (!monitor.live || !monitor.trusted) {
            monitor.trusted = false;
            return;
          }
          const open = monitor.openings.find((item) => !item.closed);
          if (
            !open ||
            open.frameId !== event.frameId ||
            open.epoch !== monitor.epoch
          ) {
            monitor.trusted = false;
            return;
          }
          open.closed = true;
          open.result = event.result;
          this.reconcileDialogs(session, page, monitor);
        });
        await cdp.send("Page.enable");
        if (
          expired ||
          this.dialogMonitors.get(page) !== monitor ||
          session.closed
        ) {
          await cdp.detach().catch(() => {});
          return;
        }
        if (session.dialog?.page === page) monitor.trusted = false;
        monitor.live = true;
      })();
      await Promise.race([
        setup,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            monitor.trusted = false;
            resolve();
          }, 2000);
        }),
      ]);
      if (expired && monitor.cdp) void monitor.cdp.detach().catch(() => {});
    } catch {
      monitor.live = false;
      monitor.trusted = false;
      if (monitor.cdp) void monitor.cdp.detach().catch(() => {});
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private closeBrowser(browser: Browser): Promise<void> {
    const owner = this.owned.get(browser);
    if (!owner) return Promise.resolve();
    if (owner.closing) return owner.closing;
    const closing = this.track(
      Promise.resolve()
        .then(() => {
          owner.closeDispatched = true;
          return owner.close();
        })
        .then(async () => {
          if (owner.poisoned) owner.lease?.abandon();
          else await owner.lease?.release();
          this.owned.delete(browser);
        })
        .catch((error) => {
          owner.lease?.abandon();
          this.cleanupFailed = true;
          throw error;
        }),
    );
    owner.closing = closing;
    return closing;
  }

  private dispose(session: Session): Promise<void> {
    if (session.disposing) return session.disposing;
    let diagnosticFailure = this.invalidate(session);
    if (session.video && this.videos) {
      try {
        this.videos.markUnverified(
          session.id,
          session.artifactOwner,
          "Owned browser closure is pending; video finalization and cleanup are unverified.",
        );
      } catch {
        diagnosticFailure = true;
      }
    }
    const closing = (async () => {
      let unverified = diagnosticFailure;
      if (this.recordings) {
        try {
          const recordingComplete = await this.recordings.endSession(
            session.id,
            session.artifactOwner,
          );
          unverified ||= !recordingComplete;
        } catch {
          unverified = true;
        }
      }
      if (this.downloads) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            this.downloads.endSession(session.id),
            new Promise<null>((resolve) => {
              timer = setTimeout(
                () => resolve(null),
                this.downloadCloseTimeoutMs,
              );
            }),
          ]);
          unverified ||= !result || result.cleanup !== "complete";
          if (!result) this.downloads.markCleanupUnverified(session.id);
        } catch {
          this.downloads.markCleanupUnverified(session.id);
          unverified = true;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      if (unverified) this.cleanupFailed = true;
      const browserOwnership = this.owned.get(session.browser);
      try {
        await this.closeBrowser(session.browser);
      } catch (error) {
        if (session.video)
          this.videos?.markUnverified(
            session.id,
            session.artifactOwner,
            "Browser closure failed; native video files were retained for recovery.",
          );
        throw error;
      }
      if (session.video && this.videos) {
        if (!browserOwnership || browserOwnership.poisoned) {
          this.videos.markUnverified(
            session.id,
            session.artifactOwner,
            "Browser ownership or closure was unverified; native video directory retained.",
          );
          unverified = true;
        } else
          try {
            const saved = await this.videos.closed(
              session.id,
              session.artifactOwner,
            );
            unverified ||= !saved;
          } catch {
            unverified = true;
          }
        if (unverified) this.cleanupFailed = true;
      }
      if (unverified || this.cleanupFailed)
        throw new Error(
          "Browser cleanup is unverified; the owned browser was closed but resources may remain.",
        );
    })();
    session.disposing = this.track(closing);
    this.disposals.set(session.browser, session.disposing);
    void session.disposing
      .finally(() => {
        if (this.disposals.get(session.browser) === session.disposing)
          this.disposals.delete(session.browser);
      })
      .catch(() => {});
    return session.disposing;
  }
  private getAttachment(id: string, owner: string): AttachedSession {
    this.check();
    const attachment = this.attachments.get(id);
    if (!attachment || attachment.owner !== owner)
      throw new Error("Attachment unavailable or owned by another Pi session.");
    return attachment;
  }

  async attachExternal(
    origin: string,
    owner: string,
    signal?: AbortSignal,
    timeoutMs = 5000,
  ) {
    this.check(signal);
    if (!owner) throw new Error("Attachment owner is required.");
    if (this.attachments.size >= 8 || this.listAttachments(owner).length >= 4)
      throw new Error("Attachment limit reached.");
    const combined = AbortSignal.any([
      this.attachmentStop.signal,
      ...(signal ? [signal] : []),
    ]);
    return this.track(
      (async () => {
        const parsed = validateAttachmentEndpoint(origin, "http:");
        if (parsed.pathname !== "/" || parsed.search)
          throw new Error("Attachment endpoint must be an origin.");
        if (
          !Number.isInteger(timeoutMs) ||
          timeoutMs < 100 ||
          timeoutMs > 30000
        )
          throw new Error("Invalid attachment timeout.");
        await discoverAttachmentEndpoint(origin, {
          signal: combined,
          timeoutMs,
        });
        if (
          combined.aborted ||
          this.closed ||
          this.attachments.size >= 8 ||
          this.listAttachments(owner).length >= 4
        ) {
          throw new Error(
            "Attachment cancelled or admission limit reached before registration.",
          );
        }
        const attachment: AttachedSession = {
          id: this.id(),
          owner,
          origin,
          diagnosticsEnabled: false,
          stop: new AbortController(),
          busy: false,
          discovered: new Set(),
        };
        if (
          this.attachments.has(attachment.id) ||
          this.sessions.has(attachment.id)
        )
          throw new Error("Duplicate attachment ID.");
        this.attachments.set(attachment.id, attachment);
        return {
          attachmentId: attachment.id,
          note: "External browser is not owned. Enumerate target IDs, then explicitly select one; no page is selected automatically.",
        };
      })(),
    );
  }

  listAttachments(owner: string) {
    this.check();
    return [...this.attachments.values()]
      .filter((item) => item.owner === owner)
      .map((item) => ({
        attachmentId: item.id,
        targetId: item.targetId ?? null,
        liveness: item.page
          ? "unverified_until_next_operation"
          : "not_selected",
      }));
  }

  async attachmentTargets(id: string, owner: string, signal?: AbortSignal) {
    const attachment = this.getAttachment(id, owner);
    if (attachment.busy)
      throw new Error(
        "Attachment is busy; retry after its current operation settles.",
      );
    attachment.busy = true;
    try {
      const combined = AbortSignal.any([
        this.attachmentStop.signal,
        attachment.stop.signal,
        AbortSignal.timeout(5000),
        ...(signal ? [signal] : []),
      ]);
      const targets = await listLocalPageTargets(attachment.origin, combined);
      if (combined.aborted || this.attachments.get(id) !== attachment)
        throw new Error("Target discovery cancelled.");
      attachment.discovered = new Set(targets.ids);
      return {
        attachmentId: id,
        targetIds: targets.ids,
        omitted: targets.omitted,
      };
    } catch (error) {
      attachment.busy = false;
      void this.disconnectAttachment(id, owner).catch(() => {});
      throw error;
    } finally {
      attachment.busy = false;
    }
  }

  async selectAttachment(
    id: string,
    owner: string,
    targetId: string,
    signal?: AbortSignal,
    timeoutMs = 5000,
  ) {
    const attachment = this.getAttachment(id, owner);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000)
      throw new Error("Invalid attachment selection timeout.");
    if (attachment.busy)
      throw new Error(
        "Attachment is busy; retry after its current operation settles.",
      );
    if (attachment.page)
      throw new Error(
        "A page is already selected; disconnect before selecting another.",
      );
    if (!attachment.discovered.has(targetId))
      throw new Error("Select an explicitly discovered page target ID.");
    attachment.busy = true;
    const combined = AbortSignal.any([
      this.attachmentStop.signal,
      attachment.stop.signal,
      ...(signal ? [signal] : []),
    ]);
    try {
      const page = await AttachedPage.connect(attachment.origin, targetId, {
        signal: combined,
        timeoutMs,
        lockRoot: this.attachmentLockRoot,
      });
      if (combined.aborted || this.attachments.get(id) !== attachment) {
        await page.disconnect();
        throw new Error("Attachment selection cancelled.");
      }
      attachment.page = page;
      attachment.targetId = targetId;
      return {
        attachmentId: id,
        targetId,
        note: "Only this explicitly selected page is leased. Diagnostics are off until explicitly enabled; events before enabling are unavailable.",
      };
    } catch (error) {
      attachment.busy = false;
      if (this.attachments.get(id) === attachment)
        void this.disconnectAttachment(id, owner).catch(() => {});
      throw error;
    } finally {
      attachment.busy = false;
    }
  }

  attachmentDiagnostics(id: string, owner: string, targetId: string) {
    const attachment = this.getAttachment(id, owner);
    if (!targetId || targetId !== attachment.targetId)
      throw new Error("Explicit selected attachment target required.");
    if (attachment.busy)
      throw new Error(
        "Attachment is busy; retry after its current operation settles.",
      );
    if (!attachment.page) throw new Error("Selected page unavailable.");
    if (!attachment.diagnosticsEnabled)
      throw new Error(
        "Page diagnostics are disabled; explicitly enable them first.",
      );
    let evidence: ReturnType<AttachedPage["diagnostics"]>;
    try {
      evidence = attachment.page.diagnostics();
    } catch (error) {
      this.attachmentCleanupUnverified = true;
      void this.disconnectAttachment(id, owner).catch(() => {});
      throw error;
    }
    const records = evidence.records;
    let omitted = 0;
    while (
      records.length &&
      Buffer.byteLength(JSON.stringify(records)) > 12000
    ) {
      records.shift();
      omitted++;
    }
    return {
      attachmentId: id,
      targetId,
      records,
      omitted,
      dropped: evidence.dropped,
      gap: "Only selected-page events after diagnostics were explicitly enabled are retained. Child-frame and worker coverage is not guaranteed; console arguments, headers and bodies are not captured.",
    };
  }

  async attachmentWork(
    id: string,
    owner: string,
    targetId: string,
    action: "navigate" | "inspect" | "title" | "start_diagnostics",
    options: { url?: string; timeoutMs?: number } = {},
    signal?: AbortSignal,
  ) {
    const attachment = this.getAttachment(id, owner);
    if (!["navigate", "inspect", "title", "start_diagnostics"].includes(action))
      throw new Error(
        "This operation is unsupported for external attachments.",
      );
    if (!targetId || targetId !== attachment.targetId)
      throw new Error("Explicit selected attachment target required.");
    if (action === "navigate" && (!options.url || options.url.length > 8192))
      throw new Error("A bounded navigation URL is required.");
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000)
      throw new Error("Invalid attachment operation timeout.");
    if (attachment.busy)
      throw new Error(
        "Attachment is busy; retry after its current operation settles.",
      );
    attachment.busy = true;
    const combined = AbortSignal.any([
      this.attachmentStop.signal,
      attachment.stop.signal,
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    try {
      const page = attachment.page;
      if (!page) throw new Error("Selected page unavailable.");
      const operation = { signal: combined, timeoutMs };
      if (action === "navigate") {
        await page.navigate(options.url!, operation);
        return {
          attachmentId: id,
          targetId,
          action,
          status: "completed",
          requestedUrl: sanitizeUrl(options.url!).slice(0, 2000),
          note: "Selected-frame load was observed; redirects and application success are not independently verified.",
        };
      }
      if (action === "start_diagnostics") {
        await page.startDiagnostics(operation);
        attachment.diagnosticsEnabled = true;
        return {
          attachmentId: id,
          targetId,
          action,
          status: "enabled",
          note: "Only selected-page console levels and sanitized request metadata are captured; earlier events are unavailable.",
        };
      }
      if (action === "title")
        return {
          attachmentId: id,
          targetId,
          action,
          ...(await page.title(operation)),
        };
      const inspected = await page.inspect(operation);
      const output = {
        attachmentId: id,
        targetId,
        action,
        ...inspected,
        scope:
          "bounded main-document DOM text; includes hidden and script text; excludes child-frame documents",
        note: "Text may contain sensitive page content.",
      };
      while (output.text && Buffer.byteLength(JSON.stringify(output)) > 12000) {
        const points = Array.from(output.text);
        output.text = points.slice(0, Math.floor(points.length * 0.7)).join("");
        output.truncated = true;
      }
      return output;
    } catch (error) {
      this.attachmentCleanupUnverified = true;
      if (this.attachments.get(id) === attachment)
        void this.disconnectAttachment(id, owner).catch(() => {});
      throw new Error(
        "Attached-page operation failed or was interrupted; its outcome may be uncertain and ownership may be quarantined. The external browser was not closed; do not retry automatically.",
        { cause: error },
      );
    } finally {
      attachment.busy = false;
    }
  }

  async disconnectAttachment(id: string, owner: string) {
    const attachment = this.getAttachment(id, owner);
    this.attachments.delete(id);
    const interrupted = attachment.busy;
    if (interrupted) this.attachmentCleanupUnverified = true;
    attachment.stop.abort();
    const closing = this.track(
      (
        attachment.page?.disconnect() ?? Promise.resolve({ uncertain: false })
      ).catch((error) => {
        this.attachmentCleanupUnverified = true;
        throw error;
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      closing,
      new Promise<{ uncertain: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ uncertain: true }), 5000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.uncertain || interrupted)
      this.attachmentCleanupUnverified = true;
    return {
      attachmentId: id,
      uncertain: outcome.uncertain || interrupted,
      note:
        outcome.uncertain || interrupted
          ? "Connection closed or closing; ownership is quarantined or cleanup is uncertain. Do not close the external browser as recovery."
          : "Disconnected only; external browser and tabs were not closed.",
    };
  }

  /** Overflow closes only a browser created by this manager. */
  failClosed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.cleanupFailed = true;
      console.warn(
        "Download cleanup overflow; closing the owned browser. Cleanup is unverified.",
      );
      void this.dispose(session).catch(() => {});
    }
  }

  private addPage(
    session: Session,
    page: Page,
    existing = false,
    initialHandoffId?: string,
  ): string {
    const id = this.id();
    if (session.pages.has(id)) throw new Error("Duplicate browser tab ID.");
    const target = { sessionId: session.id, tabId: id };
    if (initialHandoffId)
      session.handoff = { id: initialHandoffId, target, targetLost: false };
    const provenance = {
      epoch: 0,
      navigations: 0,
      requests: [] as Request[],
      current: undefined as
        | { requestedUrl: string; loaderId: string; url: string; epoch: number }
        | undefined,
    };
    const onRequest = (request: Request) => {
      if (session.handoff) {
        provenance.epoch++;
        provenance.current = undefined;
        provenance.requests = [];
        return;
      }
      try {
        if (
          !request.isNavigationRequest() ||
          request.frame() !== page.mainFrame()
        )
          return;
        provenance.epoch++;
        provenance.current = undefined;
        provenance.requests.push(request);
        if (provenance.requests.length > 100) provenance.requests.shift();
      } catch {
        provenance.epoch++;
        provenance.current = undefined;
      }
    };
    const onNavigation = (frame: ReturnType<Page["mainFrame"]>) => {
      if (frame === page.mainFrame()) {
        provenance.epoch++;
        provenance.navigations++;
        provenance.current = undefined;
      }
    };
    let diagnosticAttached = false,
      downloadAttached = false;
    const onDialog = (dialog: Dialog) => {
      if (session.closed) return;
      if (session.dialog) {
        void this.dispose(session).catch(() => {});
        return;
      }
      const id = this.id();
      const operation =
        session.operation && !session.operation.settled
          ? session.operation
          : undefined;
      const operationId = operation?.id;
      const timer = setTimeout(() => {
        void this.dispose(session).catch(() => {});
      }, 30000);
      session.dialog = {
        id,
        page,
        target,
        dialog,
        operationId,
        resolving: false,
        timer,
      };
      const monitor = this.dialogMonitors.get(page);
      if (monitor) {
        if (!monitor.live || !monitor.trusted) monitor.trusted = false;
        else {
          monitor.observed.push({
            id,
            type: dialog.type(),
            message: dialogMessageDigest(dialog.message()),
            epoch: monitor.epoch,
          });
          if (monitor.observed.length > 16) monitor.trusted = false;
          this.reconcileDialogs(session, page, monitor);
        }
      }
      operation?.notify({
        target,
        status: "awaiting_dialog",
        operationId,
        dialog: {
          id,
          type: dialog.type(),
          message: dialog.message().slice(0, 1000),
          defaultValue: dialog.defaultValue().slice(0, 1000),
        },
        note: "Origin operation may have been dispatched. Resolve explicitly; do not replay.",
      });
    };
    const onClose = () => {
      if (session.handoff?.target.tabId === id)
        session.handoff.targetLost = true;
      this.unmonitorDialog(page);
      if (session.dialog?.page === page) {
        clearTimeout(session.dialog.timer);
        session.dialog = undefined;
      }
      try {
        page.off("dialog", onDialog);
      } catch {
        this.cleanupFailed = true;
      }
      let failed = this.diagnostics?.isCleanupUnverified() ?? false;
      try {
        this.diagnostics?.detachTab({ sessionId: session.id, tabId: id });
      } catch {
        failed = true;
      }
      try {
        this.downloads?.detach({ sessionId: session.id, tabId: id }, page);
      } catch {
        failed = true;
      }
      this.dropSnapshots(page);
      session.pages.delete(id);
      this.provenance.delete(page);
      try {
        page.off("request", onRequest);
        page.off("framenavigated", onNavigation);
      } catch {
        failed = true;
      }
      if (failed) {
        this.cleanupFailed = true;
        if (!session.closed) void this.dispose(session).catch(() => {});
      }
      for (const [owner, target] of this.selected)
        if (target.sessionId === session.id && target.tabId === id)
          this.selected.delete(owner);
    };
    try {
      if (!initialHandoffId)
        this.diagnostics?.attach(target, page, existing, session.purpose);
      diagnosticAttached = !!this.diagnostics && !initialHandoffId;
      this.downloads?.attach(target, page, session.artifactOwner);
      downloadAttached = !!this.downloads;
      if (initialHandoffId) {
        session.handoffDiagnosticsGap = !!this.diagnostics;
        if (this.downloads)
          session.handoff!.downloads = this.downloads.suspendSession(
            session.id,
            session.artifactOwner,
          );
      }
      session.pages.set(id, page);
      this.provenance.set(page, provenance);
      page.on("request", onRequest);
      page.on("framenavigated", onNavigation);
      page.on("close", onClose);
      page.on("dialog", onDialog);
      return id;
    } catch (error) {
      session.pages.delete(id);
      this.provenance.delete(page);
      let cleanupFailed =
        error instanceof DiagnosticCleanupError ||
        error instanceof DownloadCleanupError;
      for (const cleanup of [
        () => page.off("close", onClose),
        () => page.off("dialog", onDialog),
        () => page.off("request", onRequest),
        () => page.off("framenavigated", onNavigation),
        () => {
          if (downloadAttached) this.downloads?.detach(target, page);
        },
        () => {
          if (diagnosticAttached) this.diagnostics?.detachTab(target);
        },
      ]) {
        try {
          cleanup();
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        this.cleanupFailed = true;
        void this.dispose(session).catch(() => {});
        throw new Error(
          "Page registration cleanup unverified; owned browser cleanup requested.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  private getSession(sessionId?: string, owner?: string): Session {
    const id = sessionId ?? this.selected.get(owner)?.sessionId;
    const session = id && this.sessions.get(id);
    const attachment = id ? this.attachments.get(id) : undefined;
    if (attachment && attachment.owner === owner)
      throw new Error(
        "This operation is unsupported for external attachments; use browser_attachment.",
      );
    if (
      !session ||
      session.closed ||
      (owner !== undefined && session.artifactOwner !== owner)
    )
      throw new Error(
        "Session unavailable; explicitly select or start a session.",
      );
    return session;
  }

  private getPage(
    target?: Partial<SessionTarget>,
    owner?: string,
  ): {
    session: Session;
    page: Page;
    target: SessionTarget;
  } {
    const session = this.getSession(target?.sessionId, owner);
    const selected = this.selected.get(owner);
    const tabId =
      target?.tabId ??
      (selected?.sessionId === session.id ? selected.tabId : undefined);
    const page = tabId && session.pages.get(tabId);
    if (!tabId || !page || page.isClosed())
      throw new Error("Tab unavailable; explicitly select a tab.");
    return { session, page, target: { sessionId: session.id, tabId } };
  }

  async trace(
    action: "start" | "stop" | "inspect",
    sessionId: string | undefined,
    owner: string,
    signal?: AbortSignal,
  ) {
    this.check(signal);
    const session = this.getSession(sessionId, owner);
    this.assertNotAwaitingHuman(session);
    if (!this.recordings) throw new Error("Native recording is unavailable.");
    const recordings = this.recordings;
    if (action === "inspect") return recordings.inspect(session.id, owner);
    return this.run(session, signal, () =>
      action === "start"
        ? recordings.start(session.id, owner, session.context)
        : recordings.stop(session.id, owner),
    );
  }

  /** Validate an explicit tab against its creating Pi session. */
  authorize(target: SessionTarget, owner: string): void {
    this.check();
    this.assertNotAwaitingHuman(this.getPage(target, owner).session);
  }

  private assertNotAwaitingHuman(session: Session): void {
    if (session.handoff || session.restartRequest)
      throw new Error(
        "Session is awaiting human confirmation; automated page work is paused.",
      );
  }

  assertSessionNotPaused(sessionId: string, owner: string): void {
    this.check();
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.artifactOwner !== owner)
      throw new Error("Session unavailable.");
    this.assertNotAwaitingHuman(session);
  }

  resumeDownloadCapture(sessionId: string, owner: string) {
    this.check();
    const session = this.getSession(sessionId, owner);
    this.assertNotAwaitingHuman(session);
    if (session.busy || session.dialog)
      throw new Error(
        "Session is busy or has a pending dialog; settle it before resuming download capture.",
      );
    if (!this.downloads) throw new Error("Download capture is unavailable.");
    const resumed = this.downloads.resumeSession(session.id, owner);
    session.handoffDownloadsGap = { ...resumed, captureRestored: true };
    return {
      sessionId: session.id,
      state: "enabled",
      ...resumed,
      warning:
        "Delayed downloads initiated by a human during handoff may now be saved as agent artifacts. Playwright downloads are browser-managed temporary files, not automatically saved to a user-chosen path.",
    };
  }

  requestVisibleRestart(target: Partial<SessionTarget>, owner: string) {
    this.check();
    const { session, target: resolved } = this.getPage(target, owner);
    if (!session.headless)
      throw new Error(
        "Session is already visible; use a normal human handoff.",
      );
    if (!session.profile)
      return {
        target: resolved,
        status: "unsupported",
        note: "Visible restart requires a named profile. No restart occurred; disposable in-memory state cannot be preserved.",
      };
    if (
      session.handoff ||
      session.restartRequest ||
      session.busy ||
      session.dialog
    )
      throw new Error(
        "Session is busy or already awaiting human confirmation.",
      );
    if (session.video)
      throw new Error(
        "Video-enabled sessions cannot be restarted for a human handoff.",
      );
    if (
      this.downloads
        ?.list(session.id)
        .some(
          (item) =>
            item.state === "pending" ||
            item.state === "saving" ||
            item.state === "unknown",
        )
    )
      throw new Error(
        "An existing download is still active or uncertain. Settle it before requesting a visible restart.",
      );
    if (this.recordings) {
      let recording: ReturnType<TraceRecordings["inspect"]> | undefined;
      try {
        recording = this.recordings.inspect(session.id, owner);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "Recording unavailable for this owner and session."
        )
          throw new Error(
            "Trace state cannot be verified; restart is unavailable.",
            { cause: error },
          );
      }
      if (recording && (recording.state !== "complete" || recording.error))
        throw new Error(
          "Stop and finalize tracing before requesting a visible restart.",
        );
    }
    const ownership = this.owned.get(session.browser);
    if (
      !ownership?.lease ||
      ownership.poisoned ||
      ownership.closing ||
      ownership.closeDispatched ||
      !this.launchPersistent
    )
      return {
        target: resolved,
        status: "unsupported",
        note: "The named profile lease cannot be transferred safely. No restart occurred.",
      };
    const id = randomUUID();
    session.restartRequest = { id, target: resolved };
    return {
      target: resolved,
      status: "awaiting_restart_consent",
      restartId: id,
      instructions: `To consent, send exactly: browser-visible-restart ${resolved.sessionId} ${id}`,
      warning:
        "The headless browser will close and restart visibly with its named profile. Unsaved forms, open tabs, in-memory page state and session-only authentication may be lost. The agent will not replay prior navigation or actions; Chromium or sites may independently restore or perform work. The old session and tab IDs will be invalidated.",
    };
  }

  cancelVisibleRestart(sessionId: string, restartId: string, owner: string) {
    this.check();
    const session = this.getSession(sessionId, owner);
    if (!session.restartRequest || session.restartRequest.id !== restartId)
      throw new Error("Restart request unavailable or ID does not match.");
    session.restartRequest = undefined;
    return {
      sessionId,
      status: "cancelled",
      note: "No restart was performed.",
    };
  }

  async confirmVisibleRestart(
    sessionId: string,
    restartId: string,
    owner: string,
    signal?: AbortSignal,
  ) {
    this.check(signal);
    const session = this.getSession(sessionId, owner);
    const request = session.restartRequest;
    if (!request || request.id !== restartId)
      throw new Error("Restart request unavailable or consent does not match.");
    const page = session.pages.get(request.target.tabId);
    if (!page || page.isClosed())
      throw new Error(
        "Restart target is unavailable; no restart was performed.",
      );
    const ownership = this.owned.get(session.browser);
    if (
      !session.profile ||
      !ownership?.lease ||
      ownership.poisoned ||
      ownership.closing ||
      ownership.closeDispatched
    )
      throw new Error(
        "Profile ownership is unavailable; no restart was performed.",
      );
    const lease = ownership.lease;
    ownership.lease = undefined;
    const state = {
      owner,
      status: "restarting" as "restarting" | "ready" | "failed",
      target: undefined as SessionTarget | undefined,
      handoffId: undefined as string | undefined,
      message: undefined as string | undefined,
    };
    this.restartResults.set(sessionId, state);
    while (this.restartResults.size > 100)
      this.restartResults.delete(this.restartResults.keys().next().value!);
    const combined = AbortSignal.any([
      AbortSignal.timeout(180000),
      ...(signal ? [signal] : []),
    ]);
    try {
      const closing = this.dispose(session);
      let abort!: () => void;
      const interrupted = new Promise<never>((_, reject) => {
        abort = () =>
          reject(
            new Error(
              "Visible restart cancelled or timed out while closing the old browser.",
            ),
          );
        combined.addEventListener("abort", abort, { once: true });
        if (combined.aborted) abort();
      });
      try {
        await Promise.race([closing, interrupted]);
      } finally {
        combined.removeEventListener("abort", abort);
      }
      if (combined.aborted || this.closed)
        throw new Error("Visible restart cancelled before launch.");
      const handoffId = randomUUID();
      const target = await this.start(
        {
          profile: session.profile,
          headless: false,
          purpose: session.purpose,
          artifactOwner: owner,
          signal: combined,
        },
        { retainedLease: lease, handoffId, previousTarget: request.target },
      );
      if (combined.aborted || this.closed) {
        const late = this.sessions.get(target.sessionId);
        if (late) void this.dispose(late).catch(() => {});
        throw new Error(
          "Visible restart was interrupted after launch; owned cleanup requested.",
        );
      }
      state.status = "ready";
      state.target = target;
      state.handoffId = handoffId;
      return {
        status: "awaiting_human",
        target,
        handoffId,
        instructions: `After completing the step in the visible browser, send exactly: browser-resume ${target.sessionId} ${handoffId}`,
        note: "Named profile lease remained held throughout restart. Old IDs were invalidated; the agent did not replay prior navigation or actions. Chromium or sites may independently restore or perform work. Transient state may be lost. Diagnostics and agent download capture remain suspended during handoff.",
      };
    } catch (error) {
      lease.abandon();
      state.status = "failed";
      state.message =
        "Visible restart failed or was interrupted. The old session is unavailable; profile ownership may be quarantined. Verify browser termination before manual recovery; do not retry automatically.";
      throw new Error(state.message, { cause: error });
    }
  }

  async beginHandoff(target: Partial<SessionTarget>, owner: string) {
    this.check();
    const { session, target: resolved } = this.getPage(target, owner);
    if (session.handoff)
      throw new Error("Session is already awaiting human confirmation.");
    if (session.busy || session.dialog)
      throw new Error(
        "Session is busy or has a pending dialog; settle it before handoff.",
      );
    if (session.headless)
      return {
        target: resolved,
        status: "unsupported",
        note: session.profile
          ? "This session is headless and cannot be made visible in place. No restart occurred. Use request_visible_restart to ask for explicit user consent; unsaved forms and in-memory state may be lost, and no actions will be replayed."
          : "This session is headless and has no named profile. Visible restart is unsupported; no restart occurred. With user consent, start a new visible session separately; unsaved forms and in-memory state may be lost, and no actions will be replayed.",
      };
    if (session.video)
      throw new Error(
        "Human handoff is unavailable while this session records video. Start a new session without video before handling login.",
      );
    if (this.recordings) {
      let recording: ReturnType<TraceRecordings["inspect"]> | undefined;
      try {
        recording = this.recordings.inspect(session.id, owner);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "Recording unavailable for this owner and session."
        )
          throw new Error(
            "Trace state cannot be verified; human handoff is unavailable.",
            { cause: error },
          );
      }
      if (recording && (recording.state !== "complete" || recording.error))
        throw new Error(
          "Stop and finalize the active trace before human handoff; raw trace capture may contain login data.",
        );
    }
    const id = randomUUID();
    session.handoff = { id, target: resolved, targetLost: false };
    try {
      if (this.downloads)
        session.handoff.downloads = this.downloads.suspendSession(
          session.id,
          owner,
        );
      this.diagnostics?.endSession(session.id);
      session.handoffDiagnosticsGap = !!this.diagnostics;
      for (const current of session.pages.values()) {
        const state = this.provenance.get(current);
        if (state) {
          state.epoch++;
          state.current = undefined;
          state.requests = [];
        }
      }
    } catch (error) {
      void this.dispose(session).catch(() => {});
      throw new Error(
        "Diagnostic or download suspension could not be verified; owned session cleanup requested.",
        { cause: error },
      );
    }
    return {
      target: resolved,
      status: "awaiting_human",
      handoffId: id,
      instructions: `After completing the step in this browser tab, send exactly: browser-resume ${resolved.sessionId} ${id}`,
      ...(session.handoff.downloads
        ? { priorDownloads: session.handoff.downloads }
        : {}),
      note: `Only explicit interactive or RPC user input can resume this session. Other browser sessions may continue. ${this.diagnostics ? "Session diagnostics are suspended; prior diagnostic history was discarded and events during handoff will be absent." : "Session diagnostics are disabled."} ${this.downloads ? "Agent download capture stays suspended after confirmation until explicitly resumed with browser_download. Delayed human downloads may be captured after that opt-in. Downloads already in flight may still publish. Playwright keeps downloads in browser-managed temporary storage, not automatically at a user-chosen path." : ""}`,
    };
  }

  handoffStatus(sessionId: string | undefined, owner: string) {
    this.check();
    const restart = sessionId ? this.restartResults.get(sessionId) : undefined;
    if (restart && restart.owner === owner) {
      const current = restart.target
        ? this.sessions.get(restart.target.sessionId)
        : undefined;
      if (
        restart.status === "ready" &&
        (!current ||
          current.closed ||
          current.artifactOwner !== owner ||
          !restart.target ||
          !current.pages.has(restart.target.tabId))
      )
        return {
          sessionId,
          status: "unavailable",
          note: "The restarted session or tab is no longer available; no target was reselected.",
        };
      const pending = current?.handoff?.id === restart.handoffId;
      return {
        sessionId,
        status: restart.status,
        ...(restart.target ? { target: restart.target } : {}),
        ...(pending && restart.target
          ? {
              handoffId: restart.handoffId,
              instructions: `After completing the step in the visible browser, send exactly: browser-resume ${restart.target.sessionId} ${restart.handoffId}`,
            }
          : {}),
        ...(restart.message ? { note: restart.message } : {}),
      };
    }
    const session = this.getSession(sessionId, owner);
    if (session.restartRequest)
      return {
        target: session.restartRequest.target,
        restartId: session.restartRequest.id,
        status: "awaiting_restart_consent",
        note: "No restart occurs without explicit user consent. Unsaved forms and in-memory state may be lost; no actions will be replayed.",
      };
    const handoff = session.handoff;
    if (!handoff)
      return {
        sessionId: session.id,
        status: "active",
        ...(session.handoffDiagnosticsGap
          ? {
              diagnosticsGap:
                "Diagnostic history before and during human handoff was discarded; recording resumed after confirmation.",
            }
          : {}),
        ...(session.handoffDownloadsGap
          ? { downloadGap: session.handoffDownloadsGap }
          : {}),
      };
    return {
      target: handoff.target,
      handoffId: handoff.id,
      status: "awaiting_human",
      targetLost: handoff.targetLost,
      ...(handoff.downloads ? { priorDownloads: handoff.downloads } : {}),
      note: handoff.targetLost
        ? "The handoff tab closed. The session remains paused; stop it rather than resuming an unrelated tab."
        : handoff.downloads
          ? "Awaiting explicit user confirmation. Agent download capture is suspended; prior downloads may still publish. Finish human downloads before confirming."
          : "Awaiting explicit user confirmation.",
    };
  }

  confirmHandoff(sessionId: string, handoffId: string, owner: string) {
    this.check();
    const session = this.getSession(sessionId, owner);
    const handoff = session.handoff;
    if (!handoff || handoff.id !== handoffId)
      throw new Error("Handoff unavailable or confirmation does not match.");
    const page = session.pages.get(handoff.target.tabId);
    if (handoff.targetLost || !page || page.isClosed())
      throw new Error(
        "Handoff tab is unavailable; session remains paused. Stop the session instead.",
      );
    if (session.dialog)
      throw new Error(
        "A browser dialog is still pending or its closure is unverified. Close it manually before confirming, or stop the session; automation remains paused.",
      );
    try {
      if (this.diagnostics) {
        for (const [tabId, tab] of session.pages) {
          if (!tab.isClosed())
            this.diagnostics.attach(
              { sessionId: session.id, tabId },
              tab,
              true,
              session.purpose,
            );
        }
      }
      for (const current of session.pages.values()) {
        const state = this.provenance.get(current);
        if (state) {
          state.epoch++;
          state.current = undefined;
          state.requests = [];
        }
      }
      if (handoff.downloads && this.downloads)
        session.handoffDownloadsGap = this.downloads.suspensionStatus(
          session.id,
          owner,
        );
    } catch (error) {
      void this.dispose(session).catch(() => {});
      throw new Error(
        "Diagnostic or download restoration failed; owned session cleanup requested and automation remains unavailable.",
        { cause: error },
      );
    }
    session.handoff = undefined;
    return {
      target: handoff.target,
      status: "resumed",
      ...(session.handoffDiagnosticsGap
        ? {
            diagnosticsGap:
              "Diagnostic history before and during human handoff was discarded; capture resumed after confirmation.",
          }
        : {}),
      ...(session.handoffDownloadsGap
        ? { downloadGap: session.handoffDownloadsGap }
        : {}),
    };
  }

  /** Races cancellation against work, invalidating and closing the owned browser if work may have dispatched. */
  private async run<T>(
    session: Session,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    this.check(signal);
    this.assertNotAwaitingHuman(session);
    if (session.dialog)
      throw new Error(
        "A browser dialog is pending; resolve it explicitly before other operations.",
      );
    if (session.busy)
      throw new Error(
        "Session is busy; retry after its current operation finishes.",
      );
    session.busy = true;
    if (!signal) {
      try {
        const value = await this.track(work());
        if (session.closed || this.closed)
          throw new Error(
            "Session closed during operation; an already dispatched action may have occurred.",
          );
        return value;
      } finally {
        session.busy = false;
      }
    }
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => {
        void this.dispose(session).catch(() => {});
        reject(
          new Error(
            "Browser operation cancelled; owned session cleanup was requested but may be incomplete. An already dispatched action may have occurred.",
          ),
        );
      };
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      if (signal.aborted) {
        cancel();
        return await cancelled;
      }
      const value = await Promise.race([this.track(work()), cancelled]);
      if (session.closed || this.closed || signal.aborted)
        throw new Error(
          "Session closed during operation; an already dispatched action may have occurred.",
        );
      return value;
    } finally {
      signal.removeEventListener("abort", cancel);
      session.busy = false;
    }
  }

  async start(
    options: {
      purpose?: SessionPurpose;
      headless?: boolean;
      signal?: AbortSignal;
      profile?: string;
      artifactOwner?: string;
      video?: boolean;
    } = {},
    internal?: {
      retainedLease: ProfileLease;
      handoffId: string;
      previousTarget: SessionTarget;
    },
  ): Promise<SessionTarget> {
    this.check(options.signal);
    const headless = options.headless ?? false;
    if (options.video && !this.videos)
      throw new Error("Video recording is unavailable.");
    const videoId = options.video ? this.id() : undefined;
    const videoOwner = videoId ? (options.artifactOwner ?? videoId) : undefined;
    const signal = options.signal;
    let cancelled = false;
    let created: Session | undefined;
    let launched: Browser | undefined;
    const startup = this.track(
      (async () => {
        let browser: Browser;
        let persistentContext: BrowserContext | undefined;
        let lease: ProfileLease | undefined;
        if (options.profile !== undefined) {
          if (!this.launchPersistent)
            throw new Error("Persistent profiles are unavailable.");
          lease =
            internal?.retainedLease ??
            (await this.acquire(options.profile, {
              root: this.profileRoot,
              timeoutMs: this.profileWaitMs,
              signal,
            }));
          if (cancelled || this.closed || signal?.aborted) {
            // No launch was dispatched, so no browser can own this profile.
            await lease.release();
            throw new Error("Browser startup cancelled before launch.");
          }
        }
        let videoDirectory: string | undefined;
        if (videoId && videoOwner) {
          try {
            videoDirectory = await this.videos!.prepare(videoId, videoOwner);
            if (cancelled || this.closed || signal?.aborted)
              throw new Error("Browser startup cancelled before launch.");
          } catch (error) {
            if (videoDirectory)
              this.videos!.markUnverified(
                videoId,
                videoOwner,
                "Startup cancelled before launch; private directory retained.",
              );
            if (lease) await lease.release();
            throw error;
          }
        }
        try {
          if (lease) {
            persistentContext = await this.launchPersistent!(lease.path, {
              headless,
              ...(videoDirectory
                ? { recordVideo: { dir: videoDirectory } }
                : {}),
            });
            const persistentBrowser = persistentContext.browser();
            if (!persistentBrowser)
              throw new Error("Persistent browser handle unavailable.");
            browser = persistentBrowser;
          } else browser = await this.launch({ headless });
        } catch (error) {
          lease?.abandon();
          if (videoId && videoOwner)
            this.videos!.markUnverified(
              videoId,
              videoOwner,
              "Browser launch failed; private video directory retained and process cleanup is unverified.",
            );
          this.launchCleanupUnverified = true;
          throw new Error(
            `Managed Chromium failed to launch. Check the matching browser installation and macOS permissions, then retry. If launch failed before a browser handle was returned, process cleanup could not be verified.${videoId ? ` Video recovery record sessionId: ${videoId}.` : ""} ${String(error).slice(0, 1000)}`,
          );
        }
        launched = browser;
        this.owned.set(browser, {
          close: () =>
            persistentContext ? persistentContext.close() : browser.close(),
          lease,
          poisoned: false,
          closeDispatched: false,
        });
        let session: Session | undefined;
        // Subscribe immediately after obtaining the handle, before any further
        // asynchronous setup. An unsolicited disconnect is not proof of exit.
        browser.on("disconnected", () => {
          const owner = this.owned.get(browser);
          if (owner && !owner.closeDispatched) {
            owner.poisoned = true;
            owner.lease?.abandon();
            this.cleanupFailed = true;
          }
          if (session)
            void this.dispose(session).catch(() => {
              this.cleanupFailed = true;
            });
        });
        const checkStartup = () => {
          if (cancelled || this.closed || signal?.aborted)
            throw new Error("Browser startup cancelled.");
          const owner = this.owned.get(browser);
          if (
            owner &&
            typeof browser.isConnected === "function" &&
            !browser.isConnected() &&
            !owner.closeDispatched
          ) {
            owner.poisoned = true;
            owner.lease?.abandon();
            this.cleanupFailed = true;
          }
          if (!owner || owner.poisoned || owner.closing || session?.closed)
            throw new Error(
              "Browser disconnected or closed before startup completed; ownership may be unverified.",
            );
        };
        try {
          checkStartup();
          const context =
            persistentContext ??
            (await browser.newContext(
              videoDirectory
                ? { recordVideo: { dir: videoDirectory } }
                : undefined,
            ));
          checkStartup();
          if (videoId && !persistentContext) {
            const ownership = this.owned.get(browser)!;
            ownership.close = async () => {
              let timer: ReturnType<typeof setTimeout> | undefined;
              let failure: unknown;
              try {
                await Promise.race([
                  context.close(),
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(
                      () =>
                        reject(
                          new Error(
                            "Video context close timed out; finalization is unverified.",
                          ),
                        ),
                      this.downloadCloseTimeoutMs,
                    );
                  }),
                ]);
              } catch (error) {
                failure = error;
              } finally {
                if (timer) clearTimeout(timer);
              }
              try {
                await browser.close();
              } catch (error) {
                failure ??= error;
              }
              if (failure) throw failure;
            };
          }
          if (videoId && videoOwner)
            this.videos!.attach(videoId, videoOwner, context, () => {
              if (session) void this.dispose(session).catch(() => {});
              else {
                cancelled = true;
                void this.closeBrowser(browser).catch(() => {});
              }
            });
          checkStartup();
          const existingPage = persistentContext?.pages()[0];
          const page = existingPage ?? (await context.newPage());
          checkStartup();
          if (page.isClosed())
            throw new Error(
              "Browser startup page closed before startup completed.",
            );
          const sessionId = videoId ?? this.id();
          if (this.sessions.has(sessionId) || this.attachments.has(sessionId))
            throw new Error("Duplicate browser session ID.");
          session = {
            id: sessionId,
            browser,
            context,
            pages: new Map(),
            purpose: options.purpose ?? "development",
            headless,
            profile: options.profile,
            closed: false,
            busy: false,
            artifactOwner: options.artifactOwner ?? "",
            video: !!videoId,
          };
          if (!session.artifactOwner) session.artifactOwner = session.id;
          created = session;
          this.sessions.set(session.id, session);
          const target = {
            sessionId: session.id,
            tabId: this.addPage(
              session,
              page,
              !!existingPage,
              internal?.handoffId,
            ),
          };
          if (
            internal &&
            (target.sessionId === internal.previousTarget.sessionId ||
              target.tabId === internal.previousTarget.tabId)
          )
            throw new Error(
              "Restart generated a duplicate session or tab ID; no target was exposed.",
            );
          await this.monitorDialogs(session, page);
          checkStartup();
          if (page.isClosed())
            throw new Error(
              "Browser startup page closed before startup completed.",
            );
          this.selected.set(options.artifactOwner, target);
          return target;
        } catch (error) {
          try {
            if (session) await this.dispose(session);
            else {
              const owner = this.owned.get(browser);
              await this.closeBrowser(browser);
              if (videoId && videoOwner) {
                if (!owner || owner.poisoned)
                  this.videos!.markUnverified(
                    videoId,
                    videoOwner,
                    "Browser ownership was unverified; native video directory retained.",
                  );
                else await this.videos!.closed(videoId, videoOwner);
              }
            }
          } catch {
            if (videoId && videoOwner)
              this.videos!.markUnverified(
                videoId,
                videoOwner,
                "Startup cleanup failed; video directory retained.",
              );
            throw new Error(
              `Browser startup failed and owned browser cleanup failed.${videoId ? ` Video recovery record sessionId: ${videoId}.` : ""} ${String(error).slice(0, 500)}`,
            );
          }
          if (videoId)
            throw new Error(
              `Browser startup failed. Video recovery record sessionId: ${videoId}. ${String(error).slice(0, 500)}`,
              { cause: error },
            );
          throw error;
        }
      })(),
    );
    if (!signal) return startup;
    let onAbort!: () => void;
    const abort = new Promise<never>((_, reject) => {
      onAbort = () => {
        cancelled = true;
        if (created) void this.dispose(created).catch(() => {});
        else if (launched) void this.closeBrowser(launched).catch(() => {});
        reject(
          new Error(
            "Browser startup cancelled; cleanup of any owned browser is requested, but may fail or remain pending. If launch has not returned a browser handle, process cleanup cannot be verified.",
          ),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      if (signal.aborted) onAbort();
      return await Promise.race([startup, abort]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  list(owner?: string): SessionSummary[] {
    this.check();
    return [...this.sessions.values()]
      .filter(
        (session) => owner === undefined || session.artifactOwner === owner,
      )
      .map((session) => ({
        sessionId: session.id,
        purpose: session.purpose,
        headless: session.headless,
        tabs: [...session.pages]
          .filter(([, page]) => !page.isClosed())
          .map(([tabId, page]) => ({
            tabId,
            url:
              session.handoff || session.restartRequest
                ? "[hidden during human handoff]"
                : presentedPageUrl(page.url()),
          })),
      }));
  }

  select(target: SessionTarget, owner?: string): SessionTarget {
    this.check();
    this.assertNotAwaitingHuman(this.getPage(target, owner).session);
    this.selected.set(owner, { ...target });
    return { ...target };
  }

  private async closeUnregisteredPage(
    session: Session,
    page: Page,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        page.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Page close timed out.")),
            this.downloadCloseTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      this.cleanupFailed = true;
      void this.dispose(session).catch(() => {});
      throw new Error(
        "Unregistered page cleanup unverified; owned browser cleanup requested.",
        { cause: error },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async newTab(
    sessionId?: string,
    signal?: AbortSignal,
    owner?: string,
  ): Promise<SessionTarget> {
    this.check(signal);
    const session = this.getSession(sessionId, owner);
    return this.run(session, signal, async () => {
      const page = await session.context.newPage();
      if (session.closed || this.closed || signal?.aborted) {
        await this.closeUnregisteredPage(session, page);
        throw new Error("Browser operation cancelled.");
      }
      let tabId: string;
      try {
        tabId = this.addPage(session, page);
        await this.monitorDialogs(session, page);
        if (session.closed || this.closed || signal?.aborted)
          throw new Error("Browser operation cancelled.");
      } catch (error) {
        await this.closeUnregisteredPage(session, page);
        throw error;
      }
      const target = { sessionId: session.id, tabId };
      this.selected.set(owner, target);
      return target;
    });
  }

  async navigate(
    url: string,
    target?: Partial<SessionTarget>,
    signal?: AbortSignal,
    timeout = 30_000,
    owner?: string,
  ) {
    this.check(signal);
    const { session, page, target: resolved } = this.getPage(target, owner);
    let notify!: (value: unknown) => void;
    const awaiting = new Promise<unknown>((resolve) => {
      notify = resolve;
    });
    const operation = {
      id: this.id(),
      notify,
      settled: false,
      result: undefined as unknown,
    };
    const work = this.run(session, signal, async () => {
      const state = this.provenance.get(page);
      if (state) {
        state.current = undefined;
        state.requests = [];
      }
      const navStart = state?.navigations;
      session.operation = operation;
      const response = await page.goto(url, { timeout });
      if (state && response && state.navigations === (navStart ?? 0) + 1) {
        const request = response.request();
        const chain: Request[] = [];
        for (
          let item: Request | null = request;
          item;
          item = item.redirectedFrom()
        )
          chain.unshift(item);
        const withoutHash = (value: string) => {
          const parsed = new URL(value);
          parsed.hash = "";
          return parsed.href;
        };
        let sameRequest = false;
        try {
          sameRequest = withoutHash(chain[0].url()) === withoutHash(url);
        } catch {}
        if (
          sameRequest &&
          chain.length === state.requests.length &&
          chain.every((item, i) => state.requests[i] === item)
        ) {
          const epoch = state.epoch;
          let cdp:
            Awaited<ReturnType<BrowserContext["newCDPSession"]>> | undefined;
          try {
            cdp = await page.context().newCDPSession(page);
            const frame = (await cdp.send("Page.getFrameTree")).frameTree.frame;
            const actualUrl = frame.url + (frame.urlFragment ?? "");
            if (
              epoch === state.epoch &&
              frame.loaderId &&
              actualUrl === page.url() &&
              withoutHash(actualUrl) === withoutHash(request.url())
            )
              state.current = {
                requestedUrl: url,
                loaderId: frame.loaderId,
                url: actualUrl,
                epoch,
              };
          } catch {
            /* Provenance is optional and fails closed. */
          } finally {
            await cdp?.detach().catch(() => {});
          }
        }
      }
      return { target: resolved, url: presentedPageUrl(page.url()) };
    }).catch((error) => {
      throw navigationError(error, signal);
    });
    void work.then(
      (value) => {
        operation.result = value;
        operation.settled = true;
      },
      (error) => {
        operation.result = {
          status: "failed",
          error: String(error).slice(0, 500),
          note: "Navigation may have started; no retry was made.",
        };
        operation.settled = true;
      },
    );
    return Promise.race([work, awaiting]);
  }

  /** Resolve provenance only against the same current main-document loader and URL. */
  requestedUrlFor(
    page: Page,
    identity: { loaderId: string; url: string },
  ): string | null {
    const state = this.provenance.get(page);
    const current = state?.current;
    return current &&
      current.epoch === state?.epoch &&
      current.loaderId === identity.loaderId &&
      current.url === identity.url &&
      page.url() === identity.url
      ? current.requestedUrl
      : null;
  }

  /** Resolve an owned page and serialize cancellable work with all other session operations. */
  async withOwnedPage<T>(
    target: Partial<SessionTarget>,
    signal: AbortSignal | undefined,
    owner: string,
    work: (page: Page, target: SessionTarget) => Promise<T>,
  ): Promise<T> {
    this.check(signal);
    const resolved = this.getPage(target, owner);
    return this.run(resolved.session, signal, () =>
      work(resolved.page, resolved.target),
    );
  }

  async snapshot(
    target: Partial<SessionTarget>,
    owner: string,
    signal?: AbortSignal,
    options: {
      selector?: string;
      frameSelector?: string;
      maxRecords?: number;
      maxChars?: number;
    } = {},
  ) {
    return this.withOwnedPage(target, signal, owner, async (page, resolved) => {
      let frame: import("playwright").Frame | undefined;
      if (options.frameSelector) {
        const element = await page
          .locator(options.frameSelector)
          .elementHandle({ timeout: 5000 });
        if (!element) throw new Error("Frame element unavailable.");
        try {
          frame = (await element.contentFrame()) ?? undefined;
          if (!frame)
            throw new Error("Selector does not identify a frame element.");
        } finally {
          await element.dispose();
        }
        if (signal?.aborted)
          throw new Error("Snapshot cancelled before capture.");
      }
      let snapshots = this.snapshots.get(page);
      if (!snapshots) {
        snapshots = this.makeSnapshots(page);
        this.snapshots.set(page, snapshots);
      }
      return {
        target: resolved,
        snapshot: await snapshots.snapshot({
          selector: options.selector,
          frame,
          maxRecords: options.maxRecords,
          maxChars: options.maxChars,
        }),
      };
    });
  }

  async validateSnapshotRef(
    target: Partial<SessionTarget>,
    owner: string,
    ref: string,
    signal?: AbortSignal,
  ) {
    return this.withOwnedPage(target, signal, owner, async (page, resolved) => {
      const snapshots = this.snapshots.get(page);
      if (!snapshots) throw new Error("Stale reference; take a new snapshot.");
      await snapshots.resolve(ref);
      return {
        target: resolved,
        ref,
        valid: true,
        note: "Validated identity only; no action was dispatched.",
      };
    });
  }

  async clickSnapshotRef(
    target: Partial<SessionTarget>,
    owner: string,
    ref: string,
    signal?: AbortSignal,
    timeout = 5000,
  ) {
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000)
      throw new Error("Click timeout must be between 100 and 30000 ms.");
    this.check(signal);
    const session = this.getPage(target, owner).session;
    let notify!: (value: unknown) => void;
    const awaiting = new Promise<unknown>((resolve) => {
      notify = resolve;
    });
    const operation = {
      id: this.id(),
      notify,
      settled: false,
      result: undefined as unknown,
    };
    const work = this.withOwnedPage(
      target,
      signal,
      owner,
      async (page, resolved) => {
        const snapshots = this.snapshots.get(page);
        if (!snapshots)
          throw new Error("Stale reference; take a new snapshot.");
        const handle = await snapshots.resolve(ref);
        if (signal?.aborted)
          throw new Error("Browser click cancelled before dispatch.");
        try {
          // Use the retained element, never a selector or a newly resolved match.
          // Page changes can still race with Playwright's actionability checks.
          session.operation = operation;
          await handle.click({ timeout });
        } catch (error) {
          throw new Error(
            `Browser click failed; dispatch may have started and the page may have changed. No automatic retry was attempted. ${String(error).slice(0, 500)}`,
            { cause: error },
          );
        }
        return {
          target: resolved,
          ref,
          action: "click",
          status: "completed",
          note: "Playwright completed the click; page effects are not independently verified.",
        };
      },
    );
    void work.then(
      (value) => {
        operation.result = value;
        operation.settled = true;
      },
      (error) => {
        operation.result = {
          status: "failed",
          error: String(error).slice(0, 500),
          note: "Click may have occurred; no retry was made.",
        };
        operation.settled = true;
      },
    );
    return Promise.race([work, awaiting]);
  }

  /** Internal hook for future dialog supervision; called before action dispatch. */
  onActionPending(
    hook: (info: {
      page: Page;
      target: SessionTarget;
      action: BrowserAction["action"];
    }) => void | (() => void),
  ): () => void {
    this.actionHooks.add(hook);
    return () => this.actionHooks.delete(hook);
  }

  async action(
    target: Partial<SessionTarget>,
    owner: string,
    args: BrowserAction,
    signal?: AbortSignal,
  ) {
    const timeout = args.timeoutMs ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000)
      throw new Error("Action timeout must be between 100 and 30000 ms.");
    if (
      ["fill", "select", "press"].includes(args.action) &&
      typeof args.value !== "string"
    )
      throw new Error("Action value is required.");
    if (args.expect?.status !== undefined && args.expect.kind !== "response")
      throw new Error("Expected status is valid only for response conditions.");
    this.check(signal);
    const session = this.getPage(target, owner).session;
    let notify!: (value: unknown) => void;
    const awaiting = new Promise<unknown>((resolve) => {
      notify = resolve;
    });
    const operation = {
      id: this.id(),
      notify,
      settled: false,
      result: undefined as unknown,
    };
    const work = this.withOwnedPage(
      target,
      signal,
      owner,
      async (page, resolved) => {
        let handle: import("playwright").ElementHandle | undefined;
        let temporary = false;
        let stopObserver: () => void = () => {};
        let verification: Promise<boolean> | undefined;
        let actionStarted = false;
        const hookCleanups: (() => void)[] = [];
        const expiry = Date.now() + timeout;
        const remaining = () => Math.max(1, expiry - Date.now());
        const unique = async (
          locator: import("playwright").Locator,
          label: string,
        ) => {
          if (signal?.aborted)
            throw new Error("Action cancelled before dispatch.");
          if (Date.now() >= expiry)
            throw new Error(
              `Action deadline expired while resolving ${label}.`,
            );
          try {
            // Locator.elementHandle waits for attachment and enforces Playwright's
            // strict single-match rule. It returns one retained handle, not a
            // locator that can reselect during the subsequent action.
            const element = await locator.elementHandle({
              timeout: remaining(),
            });
            if (!element) throw new Error(`${label} unavailable.`);
            if (signal?.aborted || Date.now() >= expiry) {
              await element.dispose().catch(() => {});
              throw new Error(
                signal?.aborted
                  ? "Action cancelled before dispatch."
                  : `Action deadline expired while resolving ${label}.`,
              );
            }
            return element;
          } catch (error) {
            const message = String(error);
            const ambiguity =
              /strict mode violation:[\s\S]*?resolved to (\d+) elements/.exec(
                message,
              );
            if (ambiguity)
              throw new Error(
                `${label} matched ${ambiguity[1]} elements; exactly one is required.`,
                { cause: error },
              );
            throw new Error(
              `Could not resolve unique ${label} within the action deadline: ${message.slice(0, 600)}`,
              { cause: error },
            );
          }
        };
        try {
          if ("ref" in args.target) {
            const snapshots = this.snapshots.get(page);
            if (!snapshots)
              throw new Error("Stale reference; take a new snapshot.");
            handle = await snapshots.resolve(args.target.ref);
          } else {
            let frame = page.mainFrame();
            if (args.target.frameSelector) {
              const locator = page.locator(args.target.frameSelector);
              const element = await unique(locator, "frame selector");
              try {
                const child = await element.contentFrame();
                if (!child)
                  throw new Error(
                    "Selector does not identify a frame element.",
                  );
                frame = child;
              } finally {
                await element.dispose();
              }
            }
            let root:
              import("playwright").Frame | import("playwright").Locator = frame;
            if (args.target.scopeSelector) {
              const scope = frame.locator(args.target.scopeSelector);
              const scopedElement = await unique(scope, "scope selector");
              await scopedElement.dispose();
              root = scope;
            }
            const locator =
              "selector" in args.target
                ? root.locator(args.target.selector)
                : root.getByRole(
                    args.target.role as Parameters<
                      import("playwright").Frame["getByRole"]
                    >[0],
                    { name: args.target.name, exact: true },
                  );
            handle = await unique(locator, "target");
            temporary = true;
          }
          if (signal?.aborted)
            throw new Error("Action cancelled before dispatch.");
          if (Date.now() >= expiry)
            throw new Error("Action deadline expired before dispatch.");
          for (const hook of this.actionHooks) {
            const cleanup = hook({
              page,
              target: resolved,
              action: args.action,
            });
            if (cleanup) hookCleanups.push(cleanup);
          }
          if (args.expect) {
            const expected = args.expect;
            let done = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let pollTimer: ReturnType<typeof setTimeout> | undefined;
            let finish!: (matched: boolean) => void;
            verification = new Promise<boolean>((resolve) => {
              finish = resolve;
            });
            const stop = (matched: boolean) => {
              if (done) return;
              done = true;
              if (timer) clearTimeout(timer);
              if (pollTimer) clearTimeout(pollTimer);
              page.off("response", response);
              page.off("framenavigated", navigation);
              signal?.removeEventListener("abort", abort);
              finish(matched);
            };
            const response = (item: import("playwright").Response) => {
              if (
                actionStarted &&
                expected.kind === "response" &&
                item.url().includes(expected.value) &&
                (expected.status === undefined ||
                  item.status() === expected.status)
              )
                stop(true);
            };
            const navigation = () => {
              if (
                actionStarted &&
                expected.kind === "url" &&
                page.url().includes(expected.value)
              )
                stop(true);
            };
            const abort = () => stop(false);
            const poll = async () => {
              if (done) return;
              if (!actionStarted) {
                pollTimer = setTimeout(poll, 0);
                return;
              }
              try {
                if (
                  expected.kind === "url" &&
                  page.url().includes(expected.value)
                )
                  return stop(true);
                if (
                  expected.kind === "text" &&
                  (await page.evaluate(
                    (text) => (document.body?.innerText ?? "").includes(text),
                    expected.value,
                  ))
                )
                  return stop(true);
              } catch {
                /* Navigation can replace the execution context. */
              }
              if (!done) pollTimer = setTimeout(poll, 50);
            };
            stopObserver = () => stop(false);
            page.on("response", response);
            page.on("framenavigated", navigation);
            signal?.addEventListener("abort", abort, { once: true });
            timer = setTimeout(() => stop(false), remaining());
            void poll();
          }
          if (signal?.aborted)
            throw new Error("Action cancelled before dispatch.");
          if (Date.now() >= expiry)
            throw new Error("Action deadline expired before dispatch.");
          let status: "completed" | "possibly_dispatched" = "completed";
          let failure: string | undefined;
          try {
            session.operation = operation;
            actionStarted = true;
            switch (args.action) {
              case "click":
                await handle.click({ timeout: remaining() });
                break;
              case "fill":
                await handle.fill(args.value!, { timeout: remaining() });
                break;
              case "select":
                await handle.selectOption(args.value!, {
                  timeout: remaining(),
                });
                break;
              case "press":
                await handle.press(args.value!, { timeout: remaining() });
                break;
              case "scroll":
                await handle.scrollIntoViewIfNeeded({ timeout: remaining() });
                break;
              case "wait":
                await handle.waitForElementState("visible", {
                  timeout: remaining(),
                });
                break;
            }
          } catch (error) {
            status =
              args.action === "wait" ? "completed" : "possibly_dispatched";
            failure = String(error).slice(0, 500);
            stopObserver();
          }
          const matched = verification ? await verification : false;
          return {
            target: resolved,
            element: args.target,
            action: args.action,
            status: failure && args.action === "wait" ? "not_started" : status,
            verification: !args.expect
              ? "no_expectation"
              : matched
                ? "verified_condition"
                : "unconfirmed",
            ...(args.expect ? { condition: args.expect.kind } : {}),
            url: presentedPageUrl(page.url()).slice(0, 1000),
            ...(failure
              ? {
                  failure,
                  note:
                    args.action === "wait"
                      ? "Readiness was not confirmed."
                      : "The action may have occurred; no automatic retry was made.",
                }
              : {}),
          };
        } finally {
          stopObserver();
          for (const cleanup of hookCleanups.reverse()) {
            try {
              cleanup();
            } catch {
              /* Hooks cannot prevent owned handle cleanup. */
            }
          }
          if (temporary) await handle?.dispose().catch(() => {});
        }
      },
    );
    void work.then(
      (value) => {
        operation.result = value;
        operation.settled = true;
      },
      (error) => {
        operation.result = {
          status: "failed",
          error: String(error).slice(0, 500),
          note: "The action may have occurred; do not replay automatically.",
        };
        operation.settled = true;
      },
    );
    return Promise.race([work, awaiting]);
  }

  async upload(
    target: Partial<SessionTarget>,
    owner: string,
    args: {
      ref?: string;
      selector?: string;
      role?: string;
      name?: string;
      frameSelector?: string;
      scopeSelector?: string;
      mode?: "input" | "chooser";
      paths: string[];
      mimeTypes?: string[];
      cwd: string;
      maxFileBytes: number;
      maxTotalBytes: number;
      timeoutMs: number;
    },
    signal?: AbortSignal,
  ) {
    this.check(signal);
    const session = this.getPage(target, owner).session;
    if (!args.paths.length || args.paths.length > 10)
      throw new Error("Upload requires 1 to 10 explicit files.");
    const targetCount =
      Number(!!args.ref) + Number(!!args.selector) + Number(!!args.role);
    if (
      targetCount !== 1 ||
      (args.role && args.name === undefined) ||
      (!args.role && args.name !== undefined) ||
      (args.mode !== "chooser" && !args.ref) ||
      (args.ref && (args.frameSelector || args.scopeSelector))
    )
      throw new Error(
        "Use one snapshot ref, or in chooser mode one strict selector or role/name target with optional frame and scope.",
      );
    if (
      args.mimeTypes &&
      (args.mimeTypes.length !== args.paths.length ||
        args.mimeTypes.some(
          (value) =>
            value.length > 255 ||
            !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value),
        ))
    )
      throw new Error("Provide one valid MIME type per upload file.");
    if (
      !Number.isSafeInteger(args.maxFileBytes) ||
      args.maxFileBytes < 1 ||
      args.maxFileBytes > 25000000 ||
      !Number.isSafeInteger(args.maxTotalBytes) ||
      args.maxTotalBytes < 1 ||
      args.maxTotalBytes > 50000000 ||
      !Number.isInteger(args.timeoutMs) ||
      args.timeoutMs < 100 ||
      args.timeoutMs > 30000
    )
      throw new Error("Invalid upload limits or deadline.");
    let notify!: (value: unknown) => void;
    const awaiting = new Promise<unknown>((resolve) => {
      notify = resolve;
    });
    const operation = {
      id: this.id(),
      notify,
      settled: false,
      result: undefined as unknown,
    };
    const work = this.withOwnedPage(
      target,
      signal,
      owner,
      async (page, resolved) => {
        const expires = Date.now() + args.timeoutMs;
        const snapshots = this.snapshots.get(page);
        let element: import("playwright").ElementHandle;
        let temporary = false;
        if (args.ref) {
          if (!snapshots)
            throw new Error("Stale reference; take a new snapshot.");
          element = await snapshots.resolve(args.ref);
        } else {
          const unique = async (
            locator: import("playwright").Locator,
            label: string,
          ) => {
            if (signal?.aborted || Date.now() >= expires)
              throw new Error(
                "Upload cancelled or deadline exceeded before dispatch.",
              );
            try {
              const handle = await locator.elementHandle({
                timeout: Math.max(1, expires - Date.now()),
              });
              if (!handle) throw new Error(`${label} unavailable.`);
              if (signal?.aborted || Date.now() >= expires) {
                await handle.dispose().catch(() => {});
                throw new Error(
                  "Upload cancelled or deadline exceeded before dispatch.",
                );
              }
              return handle;
            } catch (error) {
              const message = String(error);
              const ambiguity =
                /strict mode violation:[\s\S]*?resolved to (\d+) elements/.exec(
                  message,
                );
              if (ambiguity)
                throw new Error(
                  `${label} matched ${ambiguity[1]} elements; exactly one is required.`,
                );
              throw new Error(
                `Could not resolve unique ${label} before the upload deadline.`,
                { cause: error },
              );
            }
          };
          let frame = page.mainFrame();
          if (args.frameSelector) {
            const frameElement = await unique(
              page.locator(args.frameSelector),
              "frame selector",
            );
            try {
              const child = await frameElement.contentFrame();
              if (!child)
                throw new Error("Selector does not identify a frame element.");
              frame = child;
            } finally {
              await frameElement.dispose();
            }
          }
          let root: import("playwright").Frame | import("playwright").Locator =
            frame;
          if (args.scopeSelector) {
            const scope = frame.locator(args.scopeSelector);
            const scopeElement = await unique(scope, "scope selector");
            await scopeElement.dispose();
            root = scope;
          }
          const locator = args.selector
            ? root.locator(args.selector)
            : root.getByRole(
                args.role as Parameters<
                  import("playwright").Frame["getByRole"]
                >[0],
                { name: args.name, exact: true },
              );
          element = await unique(locator, "chooser target");
          temporary = true;
        }
        try {
          const checkInput = async (
            input: import("playwright").ElementHandle,
          ) => {
            const state = await input.evaluate((node) => ({
              file: node instanceof HTMLInputElement && node.type === "file",
              multiple: node instanceof HTMLInputElement && node.multiple,
              disabled: node instanceof HTMLInputElement && node.disabled,
              directory:
                node instanceof HTMLInputElement &&
                node.hasAttribute("webkitdirectory"),
            }));
            if (
              !state.file ||
              state.disabled ||
              state.directory ||
              (!state.multiple && args.paths.length > 1)
            )
              throw new Error(
                "Target must be an enabled non-directory file input accepting the requested file count.",
              );
          };
          if (args.mode !== "chooser") await checkInput(element);
          const files: { name: string; mimeType: string; buffer: Buffer }[] =
            [];
          let total = 0;
          for (const [index, path] of args.paths.entries()) {
            if (!path || path.length > 4096 || /[\u0000*?\[\]]/.test(path))
              throw new Error(
                `Invalid explicit upload path at index ${index}.`,
              );
            let file: Awaited<ReturnType<typeof open>> | undefined;
            try {
              if (signal?.aborted || Date.now() >= expires)
                throw new Error(
                  "Upload cancelled or deadline exceeded before dispatch.",
                );
              file = await open(
                resolve(args.cwd, path),
                fsConstants.O_RDONLY |
                  fsConstants.O_NOFOLLOW |
                  fsConstants.O_NONBLOCK,
              );
              const stat = await file.stat();
              if (
                !stat.isFile() ||
                stat.size > args.maxFileBytes ||
                total + stat.size > args.maxTotalBytes
              )
                throw new Error(
                  "File is not a regular file or exceeds upload limits.",
                );
              const buffer = Buffer.alloc(stat.size);
              let offset = 0;
              while (offset < buffer.length) {
                if (signal?.aborted || Date.now() >= expires)
                  throw new Error(
                    "Upload cancelled or deadline exceeded before dispatch.",
                  );
                const read = await file.read(
                  buffer,
                  offset,
                  buffer.length - offset,
                  offset,
                );
                if (!read.bytesRead)
                  throw new Error("File changed during read.");
                offset += read.bytesRead;
              }
              const after = await file.stat();
              if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
                throw new Error("File changed during read.");
              total += buffer.length;
              const name = basename(path);
              if (!name || Buffer.byteLength(name) > 255)
                throw new Error("Invalid filename.");
              const types: Record<string, string> = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".webp": "image/webp",
                ".svg": "image/svg+xml",
                ".pdf": "application/pdf",
                ".txt": "text/plain",
                ".csv": "text/csv",
                ".html": "text/html",
                ".htm": "text/html",
                ".json": "application/json",
                ".xml": "application/xml",
                ".zip": "application/zip",
                ".mp4": "video/mp4",
                ".mp3": "audio/mpeg",
              };
              files.push({
                name,
                mimeType:
                  args.mimeTypes?.[index]?.toLowerCase() ??
                  types[extname(name).toLowerCase()] ??
                  "application/octet-stream",
                buffer,
              });
            } catch (error) {
              throw new Error(
                `Upload file ${index + 1} could not be read as an allowed bounded regular file.`,
                { cause: error },
              );
            } finally {
              await file?.close().catch(() => {});
            }
          }
          if (args.ref) await snapshots!.resolve(args.ref);
          if (args.mode !== "chooser") await checkInput(element);
          if (signal?.aborted || Date.now() >= expires)
            throw new Error(
              "Upload cancelled or deadline exceeded before dispatch.",
            );
          session.operation = operation;
          try {
            if (args.mode === "chooser") {
              let timer: ReturnType<typeof setTimeout> | undefined;
              let onChooser!: (
                chooser: import("playwright").FileChooser,
              ) => void;
              let onAbort: (() => void) | undefined;
              const chooser = new Promise<import("playwright").FileChooser>(
                (resolve, reject) => {
                  onChooser = resolve;
                  page.on("filechooser", onChooser);
                  onAbort = () =>
                    reject(new Error("File chooser operation cancelled."));
                  signal?.addEventListener("abort", onAbort, { once: true });
                  timer = setTimeout(
                    () =>
                      reject(
                        new Error(
                          "File chooser did not appear before the deadline.",
                        ),
                      ),
                    Math.max(1, expires - Date.now()),
                  );
                },
              );
              try {
                if (signal?.aborted)
                  throw new Error(
                    "File chooser operation cancelled before dispatch.",
                  );
                const click = element.click({
                  timeout: Math.max(1, expires - Date.now()),
                });
                const selected = await Promise.race([
                  chooser,
                  click.then(
                    () => new Promise<never>(() => {}),
                    (error) => Promise.reject(error),
                  ),
                ]);
                const input = selected.element();
                try {
                  await checkInput(input);
                  if (signal?.aborted || Date.now() >= expires)
                    throw new Error(
                      "File chooser operation cancelled or deadline exceeded.",
                    );
                  await selected.setFiles(files, {
                    timeout: Math.max(1, expires - Date.now()),
                  });
                  await click;
                } finally {
                  await input.dispose().catch(() => {});
                }
              } finally {
                page.off("filechooser", onChooser);
                if (timer) clearTimeout(timer);
                if (onAbort) signal?.removeEventListener("abort", onAbort);
              }
            } else {
              await element.setInputFiles(files, {
                timeout: Math.max(1, expires - Date.now()),
              });
            }
            return {
              target: resolved,
              action: "upload",
              status: "completed",
              files: files.length,
              bytes: total,
              note: "File input was set; application processing is not independently verified.",
            };
          } catch (error) {
            if (args.mode === "chooser")
              void this.dispose(session).catch(() => {});
            return {
              target: resolved,
              action: "upload",
              status: "possibly_dispatched",
              note: "Upload may have occurred; no automatic retry was made.",
              failure: String(error).slice(0, 300),
            };
          }
        } finally {
          if (temporary) await element.dispose().catch(() => {});
        }
      },
    );
    void work.then(
      (value) => {
        operation.result = value;
        operation.settled = true;
      },
      (error) => {
        operation.result = {
          status: "failed",
          error: String(error).slice(0, 300),
        };
        operation.settled = true;
      },
    );
    return Promise.race([work, awaiting]);
  }

  async dialog(
    target: Partial<SessionTarget>,
    owner: string,
    args: {
      action: "inspect" | "refresh" | "accept" | "dismiss" | "operation";
      id?: string;
      operationId?: string;
      promptText?: string;
    },
    signal?: AbortSignal,
  ) {
    this.check(signal);
    const { session, page, target: resolved } = this.getPage(target, owner);
    this.assertNotAwaitingHuman(session);
    if (args.action === "operation") {
      const operation = session.operation;
      if (!operation || !args.operationId || args.operationId !== operation.id)
        throw new Error("Operation unavailable.");
      return {
        target: resolved,
        operationId: operation.id,
        status: operation.settled ? "settled" : "pending",
        ...(operation.settled ? { result: operation.result } : {}),
      };
    }
    const pending = session.dialog;
    if (args.action === "refresh") {
      if (!pending || pending.page !== page)
        return { target: resolved, status: "none" };
      return {
        target: resolved,
        id: pending.id,
        status: "unknown",
        operationId: pending.operationId ?? null,
        operationStatus:
          pending.operationId && session.operation?.id === pending.operationId
            ? session.operation.settled
              ? "settled"
              : "pending"
            : "unavailable",
        note: "The browser does not expose a verified dialog-open check here. A person may have dismissed it. No response was sent and the session remains blocked; explicitly stop the owned session to clean up. Unresolved dialogs also trigger owned-session cleanup after 30 seconds.",
      };
    }
    if (args.action === "inspect") {
      if (!pending || pending.page !== page)
        return { target: resolved, status: "none" };
      return {
        target: resolved,
        status: "awaiting_dialog",
        id: pending.id,
        type: pending.dialog.type(),
        message: pending.dialog.message().slice(0, 1000),
        defaultValue: pending.dialog.defaultValue().slice(0, 1000),
        operationId: pending.operationId ?? null,
        note: "This is the last observed dialog; it may have been dismissed externally. Use refresh for uncertainty and cleanup options.",
      };
    }
    if (!pending || pending.page !== page || !args.id || pending.id !== args.id)
      throw new Error("Dialog unavailable or ID does not match.");
    if (pending.resolving)
      throw new Error("Dialog resolution is already in progress.");
    if (
      args.promptText !== undefined &&
      (args.action !== "accept" || pending.dialog.type() !== "prompt")
    )
      throw new Error("Prompt text applies only when accepting a prompt.");
    pending.resolving = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const interrupt = new Promise<never>((_, reject) => {
      const fail = () => {
        void this.dispose(session).catch(() => {});
        reject(
          new Error(
            "Dialog response interrupted; the response may have occurred and owned session cleanup was requested.",
          ),
        );
      };
      abort = fail;
      signal?.addEventListener("abort", fail, { once: true });
      timer = setTimeout(fail, 5000);
      if (signal?.aborted) fail();
    });
    try {
      if (signal?.aborted) return await interrupt;
      await Promise.race([
        args.action === "accept"
          ? pending.dialog.accept(args.promptText)
          : pending.dialog.dismiss(),
        interrupt,
      ]);
      clearTimeout(pending.timer);
      if (
        args.action === "dismiss" &&
        pending.dialog.type() === "beforeunload" &&
        session.operation?.id === pending.operationId
      )
        session.operation.finishClose?.();
      if (session.dialog === pending) session.dialog = undefined;
      return {
        target: resolved,
        id: pending.id,
        action: args.action,
        status: "resolved",
        operationId: pending.operationId ?? null,
        note: "The originating operation may still be settling; inspect its status and do not replay automatically.",
      };
    } catch (error) {
      void this.dispose(session).catch(() => {});
      throw new Error(
        "Dialog response failed or is uncertain; owned session cleanup was requested and the response may have occurred.",
        { cause: error },
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }

  async screenshot(
    target: Partial<SessionTarget>,
    owner: string,
    artifacts: ArtifactStore,
    options: {
      scope: "viewport" | "fullPage" | "element";
      ref?: string;
      transparent?: boolean;
      limits: ScreenshotLimits;
    },
    signal?: AbortSignal,
  ) {
    this.check(signal);
    const resolved = this.getPage(target, owner);
    if ((options.scope === "element") !== !!options.ref)
      throw new Error(
        "Element screenshots require a snapshot ref; other scopes do not accept one.",
      );
    return this.run(resolved.session, undefined, async () => {
      const value = await captureScreenshot({
        page: resolved.page,
        owner,
        artifacts,
        scope: options.scope,
        transparent: options.transparent,
        limits: options.limits,
        signal,
        resolveElement: options.ref
          ? async () => {
              const snapshots = this.snapshots.get(resolved.page);
              if (!snapshots)
                throw new Error("Stale reference; take a new snapshot.");
              return snapshots.resolve(options.ref!);
            }
          : undefined,
        quarantine: () => {
          void this.dispose(resolved.session).catch(() => {});
        },
      });
      return { target: resolved.target, content: value.content };
    });
  }

  async viewport(
    target: Partial<SessionTarget>,
    owner: string,
    choice: ViewportChoice,
    limits: ScreenshotLimits,
    signal?: AbortSignal,
  ) {
    this.check(signal);
    const resolved = this.getPage(target, owner);
    return this.run(resolved.session, undefined, async () => ({
      target: resolved.target,
      ...(await setScreenshotViewport(
        resolved.page,
        choice,
        limits,
        signal,
        () => {
          void this.dispose(resolved.session).catch(() => {});
        },
      )),
    }));
  }

  finishPick(sessionId: string, pickerId: string, owner: string) {
    this.check();
    const session = this.getSession(sessionId, owner);
    const picker = session.picker;
    if (!picker || picker.id !== pickerId)
      throw new Error("Picker unavailable or ID does not match.");
    picker.finish.abort();
    return { target: picker.target, status: "finish_requested" };
  }

  async pick(
    target: Partial<SessionTarget>,
    owner: string,
    signal?: AbortSignal,
    options: {
      maxSelections?: number;
      onReady?: (value: {
        target: SessionTarget;
        pickerId: string;
        maxSelections: number;
      }) => void;
    } = {},
  ) {
    this.check(signal);
    const resolved = this.getPage(target, owner);
    if (resolved.session.headless)
      throw new Error("Human picker requires a visible owned session.");
    const maxSelections = options.maxSelections ?? 1;
    if (
      !Number.isInteger(maxSelections) ||
      maxSelections < 1 ||
      maxSelections > 20
    )
      throw new Error("maxSelections must be between 1 and 20.");
    // Picker teardown owns cancellation. Uncertain failures quarantine synchronously
    // before the session serialization lock is released.
    return this.run(resolved.session, undefined, async () => {
      const control = {
        id: randomUUID(),
        target: resolved.target,
        finish: new AbortController(),
        cancel: new AbortController(),
      };
      resolved.session.picker = control;
      try {
        try {
          options.onReady?.({
            target: resolved.target,
            pickerId: control.id,
            maxSelections,
          });
        } catch {
          /* The picker can still finish at its selection limit. */
        }
        const combined = AbortSignal.any([
          control.cancel.signal,
          ...(signal ? [signal] : []),
        ]);
        let picked: Awaited<ReturnType<typeof pickHumanElement>>;
        try {
          picked = await this.picker({
            page: resolved.page,
            browser: resolved.session.browser,
            signal: combined,
            finishSignal: control.finish.signal,
            maxSelections,
            onUncertainFailure: () => {
              void this.dispose(resolved.session).catch(() => {});
            },
          });
        } catch (error) {
          void this.dispose(resolved.session).catch(() => {});
          throw error;
        }
        if (picked.status !== "selected")
          return { target: resolved.target, ...picked };
        const selections = picked.selections ?? [
          {
            handle: picked.handle,
            metadata: {
              tag: picked.nodeName,
              id: "",
              classes: [],
              text: "",
              parent: null,
              summary: null,
              summaryTruncated: false,
              summaryOmissions: [],
            },
          },
        ];
        const handles = [
          ...new Set([picked.handle, ...selections.map((item) => item.handle)]),
        ];
        try {
          if (!selections.length || selections.length > maxSelections)
            throw new Error("Picker returned an invalid selection count.");
          if (combined.aborted)
            return {
              target: resolved.target,
              status: "cancelled" as const,
              reason: "aborted after selection",
            };
          const connected = await Promise.all(
            handles.map((handle) => handle.isConnected()),
          );
          if (connected.some((value) => !value))
            throw new Error("A selected node is no longer connected.");
          if (combined.aborted)
            return {
              target: resolved.target,
              status: "cancelled" as const,
              reason: "aborted after selection",
            };
          const output = {
            target: resolved.target,
            status: "selected" as const,
            selections: selections.map((item) => {
              const metadata = item.metadata;
              let truncated = false;
              const clean = (value: unknown, limit: number) => {
                if (typeof value !== "string") return "";
                if (value.length > limit) truncated = true;
                return value.slice(0, limit);
              };
              const classes = (value: unknown) => {
                if (!Array.isArray(value)) return [];
                if (value.length > 8) truncated = true;
                return value.slice(0, 8).map((item) => clean(item, 40));
              };
              const parent = metadata.parent;
              const summary =
                typeof metadata.summary === "string"
                  ? metadata.summary.slice(0, 2048)
                  : null;
              return {
                tag: clean(metadata.tag, 32),
                id: clean(metadata.id, 80),
                classes: classes(metadata.classes),
                text: clean(metadata.text, 160),
                parent:
                  parent &&
                  (parent.relation === "parent" ||
                    parent.relation === "shadow-host")
                    ? {
                        tag: clean(parent.tag, 32),
                        id: clean(parent.id, 80),
                        classes: classes(parent.classes),
                        relation: parent.relation,
                      }
                    : null,
                summary,
                summaryTruncated:
                  truncated ||
                  metadata.summaryTruncated === true ||
                  (typeof metadata.summary === "string" &&
                    metadata.summary.length > 2048),
                summaryOmissions:
                  summary === null
                    ? ["summary unavailable"]
                    : Array.isArray(metadata.summaryOmissions)
                      ? [
                          ...metadata.summaryOmissions
                            .slice(0, 8)
                            .map((value) => clean(value, 100)),
                          ...(metadata.summaryOmissions.length > 8
                            ? ["additional omissions not listed"]
                            : []),
                          ...(metadata.summaryOmissions
                            .slice(0, 8)
                            .some(
                              (value) =>
                                typeof value === "string" && value.length > 100,
                            )
                            ? ["omission details truncated"]
                            : []),
                        ]
                      : ["omission details unavailable"],
              };
            }) as (
              | { metadataOmitted: true }
              | {
                  tag: string;
                  id: string;
                  classes: string[];
                  text: string;
                  parent: {
                    tag: string;
                    id: string;
                    classes: string[];
                    relation: "parent" | "shadow-host";
                  } | null;
                  summary: string | null;
                  summaryTruncated: boolean;
                  summaryOmissions: string[];
                }
            )[],
            omittedSelectionMetadata: 0,
            actionable: false,
            note: "Selection metadata only; no actionable reference is available. The summary is synthetic, not original HTML or a selector. Form-control values are excluded, but arbitrary page text or attributes may contain secrets despite best-effort redaction.",
          };
          for (
            let i = output.selections.length - 1;
            i >= 0 && Buffer.byteLength(JSON.stringify(output), "utf8") > 15000;
            i--
          ) {
            output.selections[i] = { metadataOmitted: true };
            output.omittedSelectionMetadata++;
          }
          return output;
        } catch (error) {
          void this.dispose(resolved.session).catch(() => {});
          throw error;
        } finally {
          const outcomes = await Promise.allSettled(
            handles.map((handle) => handle.dispose()),
          );
          if (outcomes.some((outcome) => outcome.status === "rejected")) {
            void this.dispose(resolved.session).catch(() => {});
            throw new Error(
              "Picker handle cleanup could not be verified; owned session cleanup requested.",
            );
          }
        }
      } finally {
        if (resolved.session.picker === control)
          resolved.session.picker = undefined;
      }
    });
  }

  /** Main-document HTML only: iframe documents and shadow roots are separate. */
  async content(
    target?: Partial<SessionTarget>,
    signal?: AbortSignal,
    owner?: string,
  ): Promise<{ target: SessionTarget; html: string }> {
    this.check(signal);
    const { session, page, target: resolved } = this.getPage(target, owner);
    return this.run(session, signal, async () => ({
      target: resolved,
      html: await page.content(),
    }));
  }

  /** Evaluate an expression in the main frame, awaiting its result. */
  async evaluate(
    code: string,
    target?: Partial<SessionTarget>,
    signal?: AbortSignal,
    owner?: string,
  ): Promise<
    | { target: SessionTarget; text: string; representation: string }
    | DialogPendingResult
  > {
    this.check(signal);
    const { session, page, target: resolved } = this.getPage(target, owner);
    let notify!: (value: unknown) => void;
    const awaiting = new Promise<DialogPendingResult>((resolve) => {
      notify = (value) => resolve(value as DialogPendingResult);
    });
    const operation = {
      id: this.id(),
      notify,
      settled: false,
      result: undefined as unknown,
    };
    const work = this.run(session, signal, async () => {
      session.operation = operation;
      const value = await page.evaluate(async (source: string) => {
        const AsyncFunction = Object.getPrototypeOf(
          async function () {},
        ).constructor;
        const result = await new AsyncFunction(`return (${source})`)();
        if (result === undefined)
          return { text: "undefined", representation: "undefined" };
        if (typeof result === "string")
          return { text: result, representation: "string" };
        if (result === null) return { text: "null", representation: "json" };
        const ancestors = new Set<object>();
        const copy = (item: unknown): unknown => {
          if (
            item === null ||
            typeof item === "string" ||
            typeof item === "boolean"
          )
            return item;
          if (typeof item === "number") {
            if (!Number.isFinite(item) || Object.is(item, -0))
              throw new Error("Unsupported eval result number.");
            return item;
          }
          if (typeof item !== "object")
            throw new Error("Unsupported eval result value: " + typeof item);
          const prototype = Object.getPrototypeOf(item);
          const array = Array.isArray(item);
          if (
            prototype !== Object.prototype &&
            prototype !== null &&
            !(array && prototype === Array.prototype)
          )
            throw new Error("Unsupported eval result object type.");
          if (ancestors.has(item))
            throw new Error("Circular eval result is unsupported.");
          ancestors.add(item);
          try {
            const keys = Reflect.ownKeys(item);
            if (keys.some((key) => typeof key === "symbol"))
              throw new Error("Unsupported eval result symbol properties.");
            const output: any = array ? [] : Object.create(null);
            if (
              array &&
              (keys.length !== (item as unknown[]).length + 1 ||
                (keys as string[]).some(
                  (key) =>
                    key !== "length" &&
                    (!/^(0|[1-9]\d*)$/.test(key) ||
                      Number(key) >= (item as unknown[]).length),
                ))
            )
              throw new Error(
                "Sparse or extended eval result array is unsupported.",
              );
            for (const key of keys as string[]) {
              if (array && key === "length") continue;
              const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
              if (!descriptor.enumerable || !("value" in descriptor))
                throw new Error("Unsupported eval result property.");
              Object.defineProperty(output, key, {
                value: copy(descriptor.value),
                enumerable: true,
                writable: true,
                configurable: true,
              });
            }
            return output;
          } finally {
            ancestors.delete(item);
          }
        };
        return { text: JSON.stringify(copy(result)), representation: "json" };
      }, code);
      return { target: resolved, ...value };
    });
    void work.then(
      (value) => {
        const text = value.text.slice(0, 4000);
        operation.result = {
          status: "completed",
          representation: value.representation,
          text,
          truncated: text.length < value.text.length,
          note: "Bounded eval result; no operation was replayed.",
        };
        operation.settled = true;
      },
      (error) => {
        operation.result = {
          status: "failed",
          error: String(error).slice(0, 500),
          note: "Evaluation may have run; no replay was attempted.",
        };
        operation.settled = true;
      },
    );
    return Promise.race([work, awaiting]);
  }

  async closeTab(
    target?: Partial<SessionTarget>,
    signal?: AbortSignal,
    owner?: string,
  ) {
    this.check(signal);
    const { session, page, target: resolved } = this.getPage(target, owner);
    let notify!: (value: unknown) => void;
    const awaiting = new Promise<unknown>((resolve) => {
      notify = resolve;
    });
    let finishClose!: () => void;
    const dismissed = new Promise<false>((resolve) => {
      finishClose = () => resolve(false);
    });
    const operation = {
      id: this.id(),
      notify,
      finishClose,
      settled: false,
      result: undefined as unknown,
    };
    const work = this.run(session, signal, async () => {
      let onClose!: () => void;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const closed = new Promise<true>((resolve) => {
        onClose = () => resolve(true);
        page.on("close", onClose);
      });
      try {
        session.operation = operation;
        await page.close({ runBeforeUnload: true });
        const didClose =
          page.isClosed() ||
          (await Promise.race([
            closed,
            dismissed,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                void this.dispose(session).catch(() => {});
                reject(
                  new Error(
                    "Tab close outcome unverified; owned session cleanup requested.",
                  ),
                );
              }, 30000);
            }),
          ]));
        return { target: resolved, closed: didClose };
      } finally {
        page.off("close", onClose);
        if (timer) clearTimeout(timer);
      }
    });
    void work.then(
      (value) => {
        operation.result = value;
        operation.settled = true;
      },
      (error) => {
        operation.result = {
          status: "failed",
          error: String(error).slice(0, 500),
        };
        operation.settled = true;
      },
    );
    return Promise.race([work, awaiting]);
  }

  async stop(
    sessionId?: string,
    timeout = 5_000,
    signal?: AbortSignal,
    owner?: string,
  ): Promise<void> {
    this.check(signal);
    const session = this.getSession(sessionId, owner);
    const closing = this.track(this.dispose(session));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        closing,
        new Promise<never>((_, reject) => {
          onAbort = () => {
            reject(
              new Error(
                "Browser close cancelled; owned session cleanup remains pending.",
              ),
            );
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Browser close deadline exceeded; cleanup is still pending.",
                ),
              ),
            timeout,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Invalidates all IDs synchronously. Late startups are also closed when they resolve. */
  async shutdown(timeout = 5_000): Promise<{ complete: boolean }> {
    this.closed = true;
    this.attachmentStop.abort();
    const attachments = [...this.attachments.values()];
    this.attachments.clear();
    const attachmentCloses = attachments.map((attachment) => {
      if (attachment.busy) this.attachmentCleanupUnverified = true;
      attachment.stop.abort();
      return (
        attachment.page?.disconnect() ??
        Promise.resolve({ uncertain: attachment.busy })
      );
    });
    const sessions = [...this.sessions.values()];
    const browsers = new Set(sessions.map((session) => session.browser));
    const closes = [
      ...sessions.map((session) => this.dispose(session)),
      ...[...this.owned.keys()]
        .filter((browser) => !browsers.has(browser))
        .map(
          (browser) =>
            this.disposals.get(browser) ?? this.closeBrowser(browser),
        ),
    ];
    const all = Promise.all([
      Promise.allSettled([...this.pending]),
      Promise.allSettled(closes),
      Promise.allSettled(attachmentCloses),
    ]).then(
      ([, results, external]) =>
        !this.cleanupFailed &&
        !this.attachmentCleanupUnverified &&
        !this.launchCleanupUnverified &&
        results.every((result) => result.status === "fulfilled") &&
        external.every(
          (result) => result.status === "fulfilled" && !result.value.uncertain,
        ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeout);
    });
    const complete = await Promise.race([all, expired]);
    if (timer) clearTimeout(timer);
    return { complete };
  }
}
