import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireProfile, type ProfileLease } from "./profiles.ts";
import {
  discoverAttachmentEndpoint,
  validateAttachmentEndpoint,
} from "./attachment-endpoint.ts";
import { createAttachmentBridge } from "./attachment-transport.ts";
import { sanitizeUrl } from "./redaction.ts";

type Options = { signal?: AbortSignal; timeoutMs?: number };
const TITLE_LIMIT = 1024;
function safeTitle(
  value: string,
  truncated: boolean,
): { title: string; truncated: boolean } {
  let title = value.slice(0, TITLE_LIMIT);
  if (title.length && /[\uD800-\uDBFF]/.test(title.at(-1)!))
    title = title.slice(0, -1);
  return {
    title: title.replace(
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
      "\uFFFD",
    ),
    truncated: truncated || title.length < value.length,
  };
}
function safeDiagnosticUrl(value: string): string {
  if (value.length > 8192) return "[URL too long]";
  if (!/^https?:\/\//i.test(value)) return "[non-HTTP URL]";
  return sanitizeUrl(value).slice(0, 2048);
}

type Evidence =
  | { sequence: number; kind: "console"; level: string }
  | { sequence: number; kind: "request"; method: string; url: string }
  | { sequence: number; kind: "response"; status: number; url: string };

/** Direct CDP is experimental and is not a Playwright Page or a general action API. */

/** Narrow experimental page-target CDP client; never opens a browser CDP session. */
export class AttachedPage {
  private closed = false;
  private uncertain = false;
  private active = false;
  private readonly stop = new AbortController();
  private nextId = 0;
  private diagnosticsEnabled = false;
  private evidence: Evidence[] = [];
  private evidenceSequence = 0;
  private dropped = 0;
  private lifecycle: Array<{ frameId: string; loaderId: string }> = [];
  private lifecycleWaiters = new Set<() => void>();
  private pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  private readonly ws: WebSocket;
  private readonly bridge: { close(): void };
  private readonly lock: ProfileLease;
  private constructor(
    ws: WebSocket,
    bridge: { close(): void },
    lock: ProfileLease,
  ) {
    this.ws = ws;
    this.bridge = bridge;
    this.lock = lock;
    ws.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string")
          throw new Error("Invalid CDP message");
        const message = JSON.parse(event.data);
        if (!Number.isSafeInteger(message.id)) {
          this.onEvent(message.method, message.params);
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(
            new Error("Page CDP command failed; outcome uncertain"),
          );
        else pending.resolve(message.result);
      } catch {
        void this.finish(true);
      }
    });
    ws.addEventListener("close", () => {
      if (!this.closed) void this.finish(true);
    });
    ws.addEventListener("error", () => {
      if (!this.closed) void this.finish(true);
    });
  }
  static async connect(
    origin: string,
    targetId: string,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      lockRoot?: string;
    } = {},
  ): Promise<AttachedPage> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(targetId))
      throw new Error("Invalid page target ID");
    const timeout = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
      throw new Error("Invalid attachment timeout");
    if (options.signal?.aborted) throw new Error("Attachment cancelled");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeout);
    const signal = AbortSignal.any([
      deadline.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    let lock: ProfileLease | undefined;
    let bridge: Awaited<ReturnType<typeof createAttachmentBridge>> | undefined;
    let socket: WebSocket | undefined;
    try {
      const discovered = await discoverAttachmentEndpoint(origin, {
        signal,
        timeoutMs: timeout,
      });
      const browserEndpoint = validateAttachmentEndpoint(discovered, "ws:");
      const root =
        options.lockRoot ??
        join(homedir(), ".pi", "agent", "browser-attachment-leases");
      const name = `attachment-${createHash("sha256").update(targetId).digest("hex").slice(0, 48)}`;
      lock = await acquireProfile(name, {
        root,
        signal,
        timeoutMs: timeout,
      }).catch((error) => {
        if (/Profile ownership is unresolved/.test(String(error)))
          throw new Error(
            `Attachment ownership is unresolved in ${root}; verify no agent operation can still run before manual marker recovery. Do not close the external browser as a recovery step.`,
          );
        throw error;
      });
      if (signal.aborted) throw new Error("Attachment cancelled");
      bridge = await createAttachmentBridge(
        `ws://${browserEndpoint.host}/devtools/page/${targetId}`,
      );
      if (signal.aborted) throw new Error("Attachment cancelled");
      socket = new WebSocket(bridge.url);
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          signal.removeEventListener("abort", abort);
          socket!.removeEventListener("open", open);
          socket!.removeEventListener("error", error);
          socket!.removeEventListener("close", error);
        };
        const abort = () => {
          cleanup();
          reject(new Error("Attachment cancelled or timed out"));
        };
        const open = () => {
          cleanup();
          resolve();
        };
        const error = () => {
          cleanup();
          reject(new Error("Page target connection failed"));
        };
        signal.addEventListener("abort", abort, { once: true });
        socket!.addEventListener("open", open, { once: true });
        socket!.addEventListener("error", error, { once: true });
        socket!.addEventListener("close", error, { once: true });
        if (signal.aborted) abort();
      });
      if (signal.aborted || socket.readyState !== WebSocket.OPEN)
        throw new Error("Attachment cancelled or page target disconnected");
      return new AttachedPage(socket, bridge, lock);
    } catch (error) {
      bridge?.close();
      if (socket && socket.readyState === WebSocket.OPEN) socket.close();
      if (lock) await lock.release();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  private async operation<T>(
    options: Options,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeout = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
      throw new Error("Invalid attachment timeout");
    if (this.closed || options.signal?.aborted || this.active)
      throw new Error("Page attachment unavailable or busy");
    this.active = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      this.stop.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => {
        void this.finish(true);
        reject(
          new Error("Page operation cancelled or timed out; outcome uncertain"),
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await Promise.race([work(signal), cancelled]);
    } catch (error) {
      await this.finish(true);
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.active = false;
    }
  }
  private send(
    method: string,
    params: object,
    signal: AbortSignal,
  ): Promise<any> {
    if (this.closed || signal.aborted)
      return Promise.reject(new Error("Page attachment unavailable"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch {
        this.pending.delete(id);
        reject(new Error("Page CDP send failed; outcome uncertain"));
      }
    });
  }
  private onEvent(method: string, params: any) {
    if (
      method === "Page.lifecycleEvent" &&
      params?.name === "load" &&
      typeof params.frameId === "string" &&
      typeof params.loaderId === "string"
    ) {
      this.lifecycle.push({
        frameId: params.frameId,
        loaderId: params.loaderId,
      });
      if (this.lifecycle.length > 100) this.lifecycle.shift();
      for (const wake of this.lifecycleWaiters) wake();
    }
    if (!this.diagnosticsEnabled) return;
    let record: Evidence | undefined;
    if (method === "Runtime.consoleAPICalled")
      record = {
        sequence: ++this.evidenceSequence,
        kind: "console",
        level:
          typeof params?.type === "string" && /^[a-z]{1,40}$/i.test(params.type)
            ? params.type
            : "unknown",
      };
    if (
      method === "Network.requestWillBeSent" &&
      typeof params?.request?.url === "string"
    )
      record = {
        sequence: ++this.evidenceSequence,
        kind: "request",
        method:
          typeof params.request.method === "string" &&
          /^[A-Za-z]{1,20}$/.test(params.request.method)
            ? params.request.method
            : "unknown",
        url: safeDiagnosticUrl(params.request.url),
      };
    if (
      method === "Network.responseReceived" &&
      typeof params?.response?.url === "string" &&
      Number.isFinite(params.response.status)
    )
      record = {
        sequence: ++this.evidenceSequence,
        kind: "response",
        status: params.response.status,
        url: safeDiagnosticUrl(params.response.url),
      };
    if (record) {
      if (this.evidence.length === 100) {
        this.evidence.shift();
        this.dropped++;
      }
      this.evidence.push(record);
    }
  }
  /** Reads only the selected document title. */
  async title(
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ title: string; truncated: boolean }> {
    const result = await this.operation(options, (signal) =>
      this.send(
        "Runtime.evaluate",
        {
          expression:
            "(() => { const title = document.title; return { title: title.slice(0, 1024), truncated: title.length > 1024 }; })()",
          returnByValue: true,
        },
        signal,
      ),
    );
    const value = result?.result?.value;
    if (
      result?.exceptionDetails ||
      typeof value?.title !== "string" ||
      typeof value?.truncated !== "boolean"
    )
      throw new Error("Page title unavailable");
    return safeTitle(value.title, value.truncated);
  }
  /** Main-document text only: capped traversal and output, no arbitrary evaluation. */
  async inspect(options: Options = {}): Promise<{
    title: string;
    titleTruncated: boolean;
    text: string;
    truncated: boolean;
  }> {
    const expression = `(() => { const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ALL); let n = 0, text = '', x; while (n < 1000 && text.length < 16000 && (x = w.nextNode())) { n++; if (x.nodeType === Node.TEXT_NODE) text += (x.nodeValue || '').slice(0, Math.min(256, 16000 - text.length)); } const title = document.title; return { title: title.slice(0, 1024), titleTruncated: title.length > 1024, text, truncated: n >= 1000 || text.length >= 16000 }; })()`;
    const result = await this.operation(options, (signal) =>
      this.send(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        signal,
      ),
    );
    const value = result?.result?.value;
    if (
      result?.exceptionDetails ||
      typeof value?.title !== "string" ||
      typeof value?.titleTruncated !== "boolean" ||
      typeof value?.text !== "string" ||
      typeof value?.truncated !== "boolean"
    )
      throw new Error("Page inspection unavailable");
    const title = safeTitle(value.title, value.titleTruncated);
    return {
      title: title.title,
      titleTruncated: title.truncated,
      text: value.text.slice(0, 16000),
      truncated: value.truncated || value.text.length > 16000,
    };
  }
  /** Waits for a matching selected-frame loader; same-document navigation is unsupported. */
  async navigate(url: string, options: Options = {}): Promise<void> {
    if (
      typeof url !== "string" ||
      url.length > 8192 ||
      !/^https?:\/\//i.test(url)
    )
      throw new Error("Only HTTP(S) navigation is supported");
    await this.operation(options, async (signal) => {
      await this.send("Page.enable", {}, signal);
      await this.send(
        "Page.setLifecycleEventsEnabled",
        { enabled: true },
        signal,
      );
      this.lifecycle = [];
      const result = await this.send("Page.navigate", { url }, signal);
      if (
        result?.errorText ||
        typeof result?.frameId !== "string" ||
        typeof result?.loaderId !== "string"
      )
        throw new Error(
          "Navigation failed or completion cannot be verified; outcome uncertain",
        );
      if (
        this.lifecycle.some(
          (item) =>
            item.frameId === result.frameId &&
            item.loaderId === result.loaderId,
        )
      )
        return;
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          if (
            this.lifecycle.some(
              (item) =>
                item.frameId === result.frameId &&
                item.loaderId === result.loaderId,
            )
          ) {
            cleanup();
            resolve();
          }
        };
        const abort = () => {
          cleanup();
          reject(new Error("Navigation cancelled; outcome uncertain"));
        };
        const cleanup = () => {
          this.lifecycleWaiters.delete(wake);
          signal.removeEventListener("abort", abort);
        };
        this.lifecycleWaiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else wake();
      });
    });
  }
  /** Console levels and request metadata only. No console arguments, headers or bodies. */
  async startDiagnostics(options: Options = {}): Promise<void> {
    await this.operation(options, async (signal) => {
      this.diagnosticsEnabled = true;
      await this.send("Runtime.enable", {}, signal);
      await this.send(
        "Network.enable",
        { maxTotalBufferSize: 0, maxResourceBufferSize: 0 },
        signal,
      );
    });
  }
  diagnostics(): { records: Evidence[]; dropped: number } {
    if (this.closed || !this.diagnosticsEnabled)
      throw new Error("Page diagnostics unavailable");
    return {
      records: this.evidence.map((item) => ({ ...item })),
      dropped: this.dropped,
    };
  }
  private async finish(uncertain: boolean) {
    if (this.closed) return;
    this.closed = true;
    this.uncertain ||= uncertain || this.active;
    this.stop.abort();
    this.bridge.close();
    this.evidence = [];
    this.diagnosticsEnabled = false;
    for (const pending of this.pending.values())
      pending.reject(
        new Error("Page attachment disconnected; outcome uncertain"),
      );
    this.pending.clear();
    if (this.uncertain) this.lock.abandon();
    else await this.lock.release();
  }
  async disconnect(): Promise<{ uncertain: boolean }> {
    await this.finish(false);
    return { uncertain: this.uncertain };
  }
}
