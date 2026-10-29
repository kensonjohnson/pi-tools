import { randomUUID } from "node:crypto";
import {
  BodyCapture,
  type BodyDirection,
  type BodyArtifactSink,
} from "./body-capture.ts";
import type { Page, Request, Response } from "playwright";
import {
  isSensitiveHeader,
  sanitizeHeaders,
  sanitizeUrl,
} from "./redaction.ts";

export type DiagnosticTarget = { sessionId: string; tabId: string };
export class DiagnosticCleanupError extends Error {
  constructor(cause?: unknown) {
    super("Diagnostic listener cleanup unverified.", { cause });
  }
}
type LogEntry = {
  sequence: number;
  id: string;
  time: number;
  level: string;
  text: string;
  url?: string;
};
type NetworkEntry = {
  sequence: number;
  updatedSequence: number;
  id: string;
  time: number;
  method: string;
  url: string;
  resourceType: string;
  frameUrl?: string;
  redirectedFrom?: string;
  status?: number;
  outcome: "pending" | "http-error" | "success" | "transport-failure";
  failure?: string;
  durationMs?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  body: "not-captured";
  headerState: {
    request: "pending" | "complete" | "partial";
    response: "unavailable" | "pending" | "complete" | "partial";
  };
};
type StoredRequest = {
  entry: NetworkEntry;
  raw: { request: Record<string, string>; response: Record<string, string> };
  active: boolean;
  bytes: number;
  response?: Response;
  responseReadStarted?: boolean;
};
type Tab = {
  page: Page;
  active: boolean;
  started: number;
  gap: string;
  logs: LogEntry[];
  requests: StoredRequest[];
  logBytes: number;
  requestBytes: number;
  evictedLogs: number;
  evictedRequests: number;
  headerGeneration: { pending: number };
  sequence: number;
  dispose: () => void;
  bodyEvicted: (requestId: string) => void;
};
// Shared across collectors so the same Page cannot be captured by two owners.
// Pending calls remain counted across clears and reattachments because Playwright
// does not expose cancellation for allHeaders(). Weak keys do not retain pages.
const pageStates = new WeakMap<Page, { owner?: Tab; pending: number }>();
// Playwright body reads cannot be cancelled. Keep the guard across collector
// shutdown and extension reload until the underlying promises actually settle.
const responseGuardKey = Symbol.for(
  "pi-tools.browser-diagnostics.response-body-guard",
);
const globalGuards = globalThis as typeof globalThis & {
  [responseGuardKey]?: { pending: number };
};
const responseGuard = (globalGuards[responseGuardKey] ??= { pending: 0 });
const maxPendingResponseBodies = 2;

export type DiagnosticOptions = {
  maxEntries?: number;
  maxBytes?: number;
  maxFieldBytes?: number;
  maxPendingHeaders?: number;
  maxBodyBytes?: number;
  maxSessionBodyBytes?: number;
  bodyArtifactSink?: BodyArtifactSink;
  id?: () => string;
  now?: () => number;
};

function bounded(value: string, max: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= max) return value;
  return (
    bytes
      .subarray(0, Math.max(0, max - 3))
      .toString("utf8")
      .replace(/\uFFFD$/, "") + "..."
  );
}
function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Page-only collector. Call attach synchronously when an authorized Page is created,
 * before navigation. For an already-running page pass existing=true. Call detachTab
 * on close/detach and endSession on every session shutdown, including failed startup.
 * Never attach to a context or browser. Results are copies and contain no raw secrets.
 * inspectHeaders requires a retained request ID, direction and explicit names.
 * Body bytes are available only through deliberate inspection; requests are never replayed.
 */
export class BrowserDiagnostics {
  private tabs = new Map<string, Map<string, Tab>>();
  private readonly bodies: BodyCapture;
  private cleanupUnverified = false;
  isCleanupUnverified(): boolean {
    return this.cleanupUnverified;
  }
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxField: number;
  private readonly maxPending: number;
  private readonly id: () => string;
  private readonly now: () => number;
  constructor(options: DiagnosticOptions = {}) {
    const limit = (
      n: number | undefined,
      fallback: number,
      min: number,
      max: number,
    ) => {
      const v = n ?? fallback;
      if (!Number.isSafeInteger(v) || v < min || v > max)
        throw new Error("Invalid diagnostics limit.");
      return v;
    };
    this.bodies = new BodyCapture(
      options.maxBodyBytes,
      options.maxSessionBodyBytes,
      options.bodyArtifactSink,
      (sessionId, tabId, requestId) => {
        this.tabs.get(sessionId)?.get(tabId)?.bodyEvicted(requestId);
      },
    );
    this.maxEntries = limit(options.maxEntries, 500, 1, 10000);
    this.maxBytes = limit(options.maxBytes, 1024 * 1024, 512, 16 * 1024 * 1024);
    this.maxField = limit(options.maxFieldBytes, 4096, 32, 65536);
    this.maxPending = limit(options.maxPendingHeaders, 16, 1, 128);
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? Date.now;
  }
  attach(
    target: DiagnosticTarget,
    page: Page,
    existing = false,
    purpose: "development" | "research" = "development",
  ): void {
    if (!target.sessionId || !target.tabId)
      throw new Error("Session and tab are required.");
    const state = pageStates.get(page) ?? { pending: 0 };
    if (state.owner)
      throw new Error("Page diagnostics already owned by another tab.");
    let session = this.tabs.get(target.sessionId);
    if (session?.has(target.tabId))
      throw new Error("Diagnostics already attached to tab.");
    if (!session) {
      this.tabs.set(target.sessionId, (session = new Map()));
      this.bodies.start(target.sessionId, purpose === "development");
    }
    const tab: Tab = {
      page,
      active: true,
      started: this.now(),
      gap: existing
        ? "Events before attachment are unavailable."
        : "Events before listener installation are unavailable.",
      logs: [],
      requests: [],
      logBytes: 0,
      requestBytes: 0,
      evictedLogs: 0,
      evictedRequests: 0,
      headerGeneration: { pending: 0 },
      sequence: 0,
      dispose: () => {},
      bodyEvicted: () => {},
    };
    state.owner = tab;
    pageStates.set(page, state);
    session.set(target.tabId, tab);
    const requestMap = new WeakMap<Request, StoredRequest>();
    const field = (s: string) => bounded(s, this.maxField);
    const url = (s: string) => field(sanitizeUrl(s));
    const trim = () => {
      while (
        tab.requests.length > this.maxEntries ||
        tab.requestBytes > this.maxBytes
      ) {
        const old = tab.requests.shift();
        if (!old) break;
        old.active = false;
        this.bodies.drop(target.sessionId, target.tabId, old.entry.id);
        old.raw = { request: {}, response: {} };
        delete old.entry.requestHeaders;
        delete old.entry.responseHeaders;
        tab.requestBytes -= old.bytes;
        tab.evictedRequests++;
      }
    };
    const update = (r: StoredRequest, action: () => void) => {
      if (!tab.active || !r.active) return;
      tab.requestBytes -= r.bytes;
      action();
      r.entry.updatedSequence = ++tab.sequence;
      r.bytes = size({ entry: r.entry, raw: r.raw });
      tab.requestBytes += r.bytes;
      trim();
    };
    tab.bodyEvicted = (requestId) => {
      const request = tab.requests.find((r) => r.entry.id === requestId);
      if (request) update(request, () => {});
    };
    const headers = (
      r: StoredRequest,
      direction: "request" | "response",
      get: () => Promise<Record<string, string>>,
    ) => {
      if (r.entry.headerState[direction] !== "pending")
        update(r, () => {
          r.entry.headerState[direction] = "pending";
        });
      const generation = tab.headerGeneration;
      // Reserve one generation of headroom after clear, but cap all unresolved
      // calls even if clients repeatedly clear while the backend never settles.
      if (
        generation.pending >= this.maxPending ||
        state.pending >= this.maxPending * 2
      ) {
        update(r, () => {
          r.entry.headerState[direction] = "partial";
        });
        return;
      }
      generation.pending++;
      state.pending++;
      void Promise.resolve()
        .then(() => (tab.active && r.active ? get() : undefined))
        .then((h) => {
          if (!h || !tab.active || !r.active) return;
          const safe: Record<string, string> = Object.create(null),
            raw: Record<string, string> = Object.create(null);
          let used = 0,
            truncated = false;
          for (const [name, value] of Object.entries(h)) {
            if (used >= this.maxField || typeof value !== "string") {
              truncated = true;
              break;
            }
            const key = bounded(name.toLowerCase(), 128);
            const val = bounded(
              value,
              Math.min(this.maxField - used, this.maxField),
            );
            if (val !== value || key !== name.toLowerCase()) truncated = true;
            used += Buffer.byteLength(key) + Buffer.byteLength(val);
            if (isSensitiveHeader(key) && val === value) raw[key] = val;
            if (key === "location" || key === "content-location") {
              try {
                safe[key] = url(new URL(val, r.entry.url).toString());
              } catch {
                safe[key] = "[invalid URL]";
              }
            } else
              safe[key] = ["referer", "referrer"].includes(key)
                ? url(val)
                : val;
          }
          update(r, () => {
            r.raw[direction] = raw;
            const presented = sanitizeHeaders(safe);
            if (direction === "request") r.entry.requestHeaders = presented;
            else r.entry.responseHeaders = presented;
            r.entry.headerState[direction] = truncated ? "partial" : "complete";
          });
        })
        .catch(() =>
          update(r, () => {
            r.entry.headerState[direction] = "partial";
          }),
        )
        .finally(() => {
          generation.pending--;
          state.pending--;
        });
    };
    const onConsole = (message: any) => {
      if (!tab.active) return;
      const location = message.location();
      const entry: LogEntry = {
        sequence: ++tab.sequence,
        id: this.id(),
        time: this.now(),
        level: field(message.type()),
        text: field(message.text()),
        ...(location.url ? { url: url(location.url) } : {}),
      };
      const bytes = size(entry);
      tab.logs.push(entry);
      tab.logBytes += bytes;
      while (
        tab.logs.length > this.maxEntries ||
        tab.logBytes > this.maxBytes
      ) {
        const old = tab.logs.shift()!;
        tab.logBytes -= size(old);
        tab.evictedLogs++;
      }
    };
    const onError = (error: Error) =>
      onConsole({
        location: () => ({}),
        type: () => "pageerror",
        text: () => error.message,
      });
    const onRequest = (request: Request) => {
      if (!tab.active) return;
      let frameUrl: string | undefined;
      try {
        frameUrl = url(request.frame().url());
      } catch {
        /* service worker or unavailable frame */
      }
      const previous = request.redirectedFrom();
      const r: StoredRequest = {
        entry: {
          sequence: ++tab.sequence,
          updatedSequence: tab.sequence,
          id: this.id(),
          time: this.now(),
          method: field(request.method()),
          url: url(request.url()),
          resourceType: field(request.resourceType()),
          ...(frameUrl ? { frameUrl } : {}),
          ...(previous && requestMap.get(previous)
            ? { redirectedFrom: requestMap.get(previous)!.entry.id }
            : {}),
          outcome: "pending",
          body: "not-captured",
          headerState: { request: "pending", response: "unavailable" },
        },
        raw: { request: {}, response: {} },
        active: true,
        bytes: 0,
      };
      r.bytes = size({ entry: r.entry, raw: r.raw });
      tab.requests.push(r);
      tab.requestBytes += r.bytes;
      requestMap.set(request, r);
      trim();
      if (!r.active) return;
      this.bodies.begin(target.sessionId, target.tabId, r.entry.id);
      if (this.bodies.enabled(target.sessionId)) {
        try {
          // Playwright already buffered post data before emitting the event. This
          // limits our retained copy, not Playwright's transport memory.
          if (typeof request.postDataBuffer !== "function")
            this.bodies.set(
              target.sessionId,
              target.tabId,
              r.entry.id,
              "request",
              "unsupported",
            );
          else {
            const data = request.postDataBuffer();
            this.bodies.set(
              target.sessionId,
              target.tabId,
              r.entry.id,
              "request",
              data === null ? "absent" : "captured",
              data ?? undefined,
            );
          }
        } catch {
          this.bodies.set(
            target.sessionId,
            target.tabId,
            r.entry.id,
            "request",
            "failed",
          );
        }
      }
      trim();
      if (r.active) headers(r, "request", () => request.allHeaders());
    };
    const onResponse = (response: Response) => {
      const r = requestMap.get(response.request());
      if (!r || !r.active || !tab.active) return;
      r.response = response;
      update(r, () => {
        r.entry.status = response.status();
      });
      if (r.active) headers(r, "response", () => response.allHeaders());
    };
    const onFinished = (request: Request) => {
      const r = requestMap.get(request);
      if (!r) return;
      if (!tab.active || !r.active) return;
      if (
        !r.responseReadStarted &&
        this.bodies.state(
          target.sessionId,
          target.tabId,
          r.entry.id,
          "response",
        ) === "pending"
      ) {
        r.responseReadStarted = true;
        const set = (
          state: import("./body-capture.ts").BodyState,
          reason?: string,
          bytes?: Buffer,
        ) => {
          if (!tab.active || !r.active) return;
          this.bodies.set(
            target.sessionId,
            target.tabId,
            r.entry.id,
            "response",
            state,
            bytes,
            reason,
          );
          update(r, () => {});
        };
        const response = r.response;
        r.response = undefined;
        try {
          if (!response) set("absent", "No response was observed.");
          else {
            const h = response.headers();
            const length = h["content-length"];
            const encoding = h["content-encoding"]?.trim().toLowerCase();
            const transfer = h["transfer-encoding"];
            const media = h["content-type"]?.toLowerCase() ?? "";
            if (response.status() >= 300 && response.status() < 400)
              set("unsupported", "Redirect response bodies are not captured.");
            else if (encoding && encoding !== "identity")
              set(
                "unsupported",
                "Compressed or ambiguous content encoding is not captured.",
              );
            else if (transfer || media.includes("text/event-stream"))
              set(
                "unsupported",
                "Streaming or transfer-encoded responses are not captured.",
              );
            else if (
              !length ||
              !/^(0|[1-9][0-9]*)$/.test(length) ||
              !Number.isSafeInteger(Number(length))
            )
              set(
                "unsupported",
                "Missing or ambiguous Content-Length; body not captured.",
              );
            else if (Number(length) > this.bodies.maxBody)
              set(
                "oversized",
                "Declared Content-Length exceeds the per-body limit.",
              );
            else if (responseGuard.pending >= maxPendingResponseBodies)
              set("unsupported", "Response body read capacity exhausted.");
            else {
              responseGuard.pending++;
              // Content-Length is untrusted. response.body() may transiently allocate
              // more than the retention limit in Chromium, transport, and Node.
              void Promise.resolve()
                .then(() =>
                  tab.active && r.active ? response.body() : undefined,
                )
                .then(
                  (bytes) => {
                    if (!bytes || !tab.active || !r.active) return;
                    if (bytes.length > this.bodies.maxBody)
                      set(
                        "oversized",
                        "Received body exceeds the per-body limit.",
                      );
                    else if (bytes.length !== Number(length))
                      set(
                        "failed",
                        "Received byte count differs from Content-Length.",
                      );
                    else set("captured", undefined, bytes);
                  },
                  () =>
                    set(
                      "failed",
                      "Response body unavailable or evicted by the browser.",
                    ),
                )
                .finally(() => {
                  responseGuard.pending--;
                });
            }
          }
        } catch {
          set("failed", "Response metadata unavailable.");
        }
      }
      update(r, () => {
        r.entry.durationMs = Math.max(0, this.now() - r.entry.time);
        if (r.entry.outcome === "pending")
          r.entry.outcome =
            (r.entry.status ?? 0) >= 400 ? "http-error" : "success";
      });
    };
    const onFailed = (request: Request) => {
      const r = requestMap.get(request);
      if (!r) return;
      if (
        this.bodies.state(
          target.sessionId,
          target.tabId,
          r.entry.id,
          "response",
        ) === "pending"
      )
        this.bodies.set(
          target.sessionId,
          target.tabId,
          r.entry.id,
          "response",
          "failed",
        );
      update(r, () => {
        r.entry.durationMs = Math.max(0, this.now() - r.entry.time);
        r.entry.outcome = "transport-failure";
        r.entry.failure = field(
          request.failure()?.errorText ?? "Unknown transport failure",
        );
      });
    };
    const close = () => {
      try {
        this.detachTab(target);
      } catch {
        this.cleanupUnverified = true;
      }
    };
    tab.dispose = () => {
      let failed = false;
      for (const [name, listener] of [
        ["console", onConsole],
        ["pageerror", onError],
        ["request", onRequest],
        ["response", onResponse],
        ["requestfinished", onFinished],
        ["requestfailed", onFailed],
        ["close", close],
      ] as const) {
        try {
          page.off(name, listener as never);
        } catch {
          failed = true;
        }
      }
      if (failed) throw new DiagnosticCleanupError();
    };
    try {
      page.on("console", onConsole);
      page.on("pageerror", onError);
      page.on("request", onRequest);
      page.on("response", onResponse);
      page.on("requestfinished", onFinished);
      page.on("requestfailed", onFailed);
      page.on("close", close);
    } catch (error) {
      try {
        this.detachTab(target);
      } catch (cleanupError) {
        throw new DiagnosticCleanupError(cleanupError);
      }
      throw error;
    }
  }
  private get(target: DiagnosticTarget): Tab {
    const tab = this.tabs.get(target.sessionId)?.get(target.tabId);
    if (!tab?.active)
      throw new Error("Diagnostics unavailable for session/tab.");
    return tab;
  }
  detachTab(target: DiagnosticTarget): void {
    const session = this.tabs.get(target.sessionId);
    const tab = session?.get(target.tabId);
    if (!tab) return;
    tab.active = false;
    let cleanupError: unknown;
    try {
      tab.dispose();
    } catch (error) {
      cleanupError = error;
      this.cleanupUnverified = true;
    }
    const state = pageStates.get(tab.page);
    if (!cleanupError && state?.owner === tab) state.owner = undefined;
    for (const r of tab.requests) {
      r.active = false;
      this.bodies.drop(target.sessionId, target.tabId, r.entry.id);
      r.raw = { request: {}, response: {} };
      delete r.entry.requestHeaders;
      delete r.entry.responseHeaders;
    }
    tab.logs.length = 0;
    tab.requests.length = 0;
    session!.delete(target.tabId);
    if (!session!.size) this.tabs.delete(target.sessionId);
    if (cleanupError) throw new DiagnosticCleanupError(cleanupError);
  }
  endSession(sessionId: string): void {
    let failed = false;
    for (const tabId of [...(this.tabs.get(sessionId)?.keys() ?? [])]) {
      try {
        this.detachTab({ sessionId, tabId });
      } catch {
        failed = true;
      }
    }
    try {
      this.bodies.end(sessionId);
    } catch {
      failed = true;
    }
    if (failed) {
      this.cleanupUnverified = true;
      throw new DiagnosticCleanupError();
    }
  }
  shutdown(): void {
    let failed = false;
    for (const sessionId of [...this.tabs.keys()]) {
      try {
        this.endSession(sessionId);
      } catch {
        failed = true;
      }
    }
    try {
      this.bodies.shutdown();
    } catch {
      failed = true;
    }
    if (failed || this.cleanupUnverified) throw new DiagnosticCleanupError();
  }
  clear(target: DiagnosticTarget): void {
    const tab = this.get(target);
    for (const r of tab.requests) {
      r.active = false;
      this.bodies.drop(target.sessionId, target.tabId, r.entry.id);
      r.raw = { request: {}, response: {} };
      delete r.entry.requestHeaders;
      delete r.entry.responseHeaders;
    }
    tab.logs.length = 0;
    tab.requests.length = 0;
    tab.logBytes = tab.requestBytes = 0;
    tab.headerGeneration = { pending: 0 };
    tab.evictedLogs = tab.evictedRequests = 0;
    tab.started = this.now();
    tab.gap = "History cleared; earlier events are unavailable.";
  }
  read(
    target: DiagnosticTarget,
    filter: {
      since?: number;
      level?: string;
      url?: string;
      status?: number;
      resourceType?: string;
      afterId?: string;
      afterSequence?: number;
    } = {},
  ) {
    const tab = this.get(target);
    if (filter.afterId !== undefined && filter.afterSequence !== undefined)
      throw new Error("Choose afterId or afterSequence, not both.");
    if (
      filter.afterSequence !== undefined &&
      (!Number.isSafeInteger(filter.afterSequence) ||
        filter.afterSequence < 0 ||
        filter.afterSequence > tab.sequence)
    )
      throw new Error("Sequence cursor unavailable.");
    const cursor =
      filter.afterId === undefined
        ? undefined
        : (tab.logs.find((x) => x.id === filter.afterId) ??
          tab.requests.find((x) => x.entry.id === filter.afterId)?.entry);
    if (filter.afterId !== undefined && !cursor)
      throw new Error("Cursor unavailable or evicted.");
    const sinceSequence = filter.afterSequence ?? cursor?.sequence ?? 0;
    const matches = (x: {
      time: number;
      sequence: number;
      updatedSequence?: number;
    }) =>
      (filter.since === undefined || x.time >= filter.since) &&
      (x.updatedSequence ?? x.sequence) > sinceSequence;
    const logs = tab.logs.filter(
      (x) =>
        matches(x) &&
        filter.status === undefined &&
        !filter.resourceType &&
        (!filter.level || x.level === filter.level) &&
        (!filter.url || x.url?.includes(filter.url)),
    );
    const requests = tab.requests
      .map((x) => ({
        ...x.entry,
        body: {
          request: this.bodies.state(
            target.sessionId,
            target.tabId,
            x.entry.id,
            "request",
          ),
          response: this.bodies.state(
            target.sessionId,
            target.tabId,
            x.entry.id,
            "response",
          ),
          responseReason: this.bodies.reason(
            target.sessionId,
            target.tabId,
            x.entry.id,
            "response",
          ),
        },
      }))
      .filter(
        (x) =>
          matches(x) &&
          !filter.level &&
          (!filter.url || x.url.includes(filter.url)) &&
          (filter.status === undefined || x.status === filter.status) &&
          (!filter.resourceType || x.resourceType === filter.resourceType),
      );
    return structuredClone({
      captureStarted: tab.started,
      nextSequence: tab.sequence,
      gaps: [
        tab.gap,
        "Only page events are captured; service-worker and unassignable browser-wide events may be missing.",
        "Console text may contain secrets; arbitrary secret detection is not provided.",
        "Response capture is best effort. Content-Length is untrusted; Playwright body reads can exceed retention limits transiently in browser, transport, or Node. Request data may also be buffered before diagnostics limits apply.",
      ],
      evictedLogs: tab.evictedLogs,
      evictedRequests: tab.evictedRequests,
      logs,
      requests,
    });
  }
  configureBodies(target: DiagnosticTarget, enabled: boolean) {
    this.get(target);
    this.bodies.configure(target.sessionId, enabled);
    return { enabled, notice: "Changes apply to new requests only." };
  }
  exportBody(
    target: DiagnosticTarget,
    requestId: string,
    direction: BodyDirection,
    owner: string,
    signal?: AbortSignal,
  ) {
    this.get(target);
    if (direction !== "request" && direction !== "response")
      throw new Error("Invalid body direction.");
    return this.bodies.export(
      target.sessionId,
      target.tabId,
      requestId,
      direction,
      owner,
      signal,
    );
  }
  inspectBody(
    target: DiagnosticTarget,
    requestId: string,
    direction: BodyDirection,
    offset?: number,
    maxBytes?: number,
  ) {
    this.get(target);
    if (direction !== "request" && direction !== "response")
      throw new Error("Invalid body direction.");
    return this.bodies.inspect(
      target.sessionId,
      target.tabId,
      requestId,
      direction,
      offset,
      maxBytes,
    );
  }
  inspectHeaders(
    target: DiagnosticTarget,
    requestId: string,
    direction: "request" | "response",
    names: string[],
  ): { values: Record<string, string>; unavailable: string[] } {
    if (direction !== "request" && direction !== "response")
      throw new Error("Invalid header direction.");
    if (
      !Array.isArray(names) ||
      !names.length ||
      names.length > 32 ||
      names.some((n) => typeof n !== "string" || n.length > 128)
    )
      throw new Error("Select 1-32 header names.");
    const r = this.get(target).requests.find((x) => x.entry.id === requestId);
    if (!r) throw new Error("Request unavailable or evicted.");
    const values: Record<string, string> = Object.create(null),
      unavailable: string[] = [];
    for (const name of names) {
      const key = name.toLowerCase();
      const value = r.raw[direction][key];
      if (value === undefined) unavailable.push(key);
      else values[key] = value;
    }
    return { values, unavailable };
  }
}
