import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  createProtocolConnection,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentDiagnosticRequest,
  ExitNotification,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  ShutdownRequest,
  UnregistrationRequest,
  DiagnosticRefreshRequest,
  WorkspaceDiagnosticRequest,
  type Diagnostic,
  type DocumentDiagnosticReport,
  type InitializeResult,
  type ProtocolConnection,
  type WorkspaceDiagnosticReport,
} from "vscode-languageserver-protocol/node";

export type LspAvailabilityReason =
  | "unconfigured"
  | "offline"
  | "unavailable"
  | "broken"
  | "closed"
  | "timeout"
  | "cancelled"
  | "unsupported";

export type LspOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "unavailable"; reason: LspAvailabilityReason };

export type LspClientState = "starting" | "ready" | "broken" | "closed";

export type LspClock = {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type LspChildProcess = Pick<
  ChildProcess,
  "stdin" | "stdout" | "kill" | "on" | "once"
>;

export type LspLaunchOptions = {
  command: string;
  arguments: readonly string[];
  cwd: string;
};

export type LspRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type LspDocument = {
  uri: string;
  languageId: string;
  text: string;
  version: number;
};

export type LspClientOptions = {
  rootPath: string;
  process: LspChildProcess;
  clock?: LspClock;
  requestTimeoutMs?: number;
  /** Server-specific initialize payload selected by the managed catalog. */
  initializationOptions?: Record<string, unknown>;
  /** Debounce period after a push update before exposing it as fresh. */
  pushDiagnosticQuietMs?: number;
};

type PushDiagnosticRecord = {
  generation: number;
  version: number | undefined;
  diagnostics: readonly Diagnostic[];
};

const SYSTEM_CLOCK: LspClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

// TypeScript Language Server can publish an unversioned result 300–800ms after
// didChange, then adds its own 50ms publication debounce. Keep listening past
// that window so a delayed old-content result cannot be returned as current.
const DEFAULT_PUSH_DIAGNOSTIC_QUIET_MS = 900;

/** Spawns a stdio server without a shell and consumes launch errors immediately. */
export function launchLspServer(
  options: LspLaunchOptions,
): Promise<ChildProcess> {
  const child = spawn(options.command, [...options.arguments], {
    cwd: options.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // A failed spawn emits asynchronously. Keep an error listener even if callers
  // cannot construct a client (and therefore cannot install their own listener).
  child.on("error", () => {});
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}

/** A session-owned, stdio-only LSP connection. */
export class LspClient {
  readonly rootPath: string;
  readonly process: LspChildProcess;
  readonly diagnostics = new Map<string, readonly Diagnostic[]>();

  #connection: ProtocolConnection | undefined;
  #state: LspClientState = "starting";
  #capabilities: InitializeResult["capabilities"] | undefined;
  #documents = new Map<string, LspDocument>();
  #documentResultIds = new Map<string, string>();
  #diagnosticRefreshGeneration = 0;
  #dynamicDocumentDiagnosticRegistrations = new Set<string>();
  #dynamicWorkspaceDiagnosticRegistrations = new Set<string>();
  #pushDiagnostics = new Map<string, PushDiagnosticRecord>();
  #pushDiagnosticWaiters = new Set<() => void>();
  #pushDiagnosticGeneration = 0;
  #clock: LspClock;
  #requestTimeoutMs: number;
  #initializationOptions: Record<string, unknown> | undefined;
  #pushDiagnosticQuietMs: number;
  #closing = false;

  constructor(options: LspClientOptions) {
    this.rootPath = options.rootPath;
    this.process = options.process;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#initializationOptions = options.initializationOptions;
    this.#pushDiagnosticQuietMs =
      options.pushDiagnosticQuietMs ?? DEFAULT_PUSH_DIAGNOSTIC_QUIET_MS;

    this.process.on("error", () => this.#markBroken());
    this.process.once("exit", () => {
      if (!this.#closing) this.#markBroken();
    });
  }

  get state(): LspClientState {
    return this.#state;
  }

  get capabilities(): InitializeResult["capabilities"] | undefined {
    return this.#capabilities;
  }

  get supportsDocumentDiagnostics(): boolean {
    return (
      this.#capabilities?.diagnosticProvider !== undefined ||
      this.#dynamicDocumentDiagnosticRegistrations.size > 0
    );
  }

  get supportsWorkspaceDiagnostics(): boolean {
    const provider = this.#capabilities?.diagnosticProvider;
    return (
      (typeof provider === "object" &&
        provider !== null &&
        provider.workspaceDiagnostics === true) ||
      this.#dynamicWorkspaceDiagnosticRegistrations.size > 0
    );
  }

  getDiagnostics(uri: string): readonly Diagnostic[] {
    return [...(this.diagnostics.get(uri) ?? [])];
  }

  async initialize(options: LspRequestOptions = {}): Promise<LspOutcome<void>> {
    if (this.#state === "ready") return { status: "ok", value: undefined };
    if (this.#state === "broken") return unavailable("broken");
    if (this.#state === "closed") return unavailable("closed");
    if (!this.process.stdin || !this.process.stdout) {
      this.#markBroken();
      return unavailable("broken");
    }

    const connection = createProtocolConnection(
      this.process.stdout,
      this.process.stdin,
    );
    this.#connection = connection;
    connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      // publishDiagnostics is a complete replacement for this URI; an empty
      // array is therefore an explicit clear rather than a stale clean result.
      const diagnostics = [...params.diagnostics];
      this.diagnostics.set(params.uri, diagnostics);
      this.#pushDiagnostics.set(params.uri, {
        generation: ++this.#pushDiagnosticGeneration,
        version:
          typeof params.version === "number" ? params.version : undefined,
        diagnostics,
      });
      for (const wake of this.#pushDiagnosticWaiters) wake();
    });
    connection.onRequest(RegistrationRequest.type, (params) => {
      for (const registration of params.registrations) {
        if (registration.method !== DocumentDiagnosticRequest.method) continue;
        this.#dynamicDocumentDiagnosticRegistrations.add(registration.id);
        if (
          registrationProvidesWorkspaceDiagnostics(registration.registerOptions)
        ) {
          this.#dynamicWorkspaceDiagnosticRegistrations.add(registration.id);
        } else {
          this.#dynamicWorkspaceDiagnosticRegistrations.delete(registration.id);
        }
      }
    });
    connection.onRequest(UnregistrationRequest.type, (params) => {
      for (const registration of params.unregisterations) {
        if (registration.method === DocumentDiagnosticRequest.method) {
          this.#dynamicDocumentDiagnosticRegistrations.delete(registration.id);
          this.#dynamicWorkspaceDiagnosticRegistrations.delete(registration.id);
        }
      }
    });
    connection.onRequest(DiagnosticRefreshRequest.type, () => {
      // A refresh invalidates all pull result ids. The next request must not be
      // allowed to receive an unchanged response for a now-stale result.
      this.#diagnosticRefreshGeneration += 1;
      this.#documentResultIds.clear();
    });
    connection.onError(() => this.#markBroken());
    connection.onClose(() => {
      if (!this.#closing) this.#markBroken();
    });
    connection.listen();

    const initialized = await this.#request<InitializeResult>(
      InitializeRequest.type,
      {
        processId: process.pid,
        clientInfo: { name: "pi-tools" },
        rootUri: pathToFileURL(this.rootPath).toString(),
        workspaceFolders: [
          {
            uri: pathToFileURL(this.rootPath).toString(),
            name: basename(this.rootPath),
          },
        ],
        ...(this.#initializationOptions
          ? { initializationOptions: this.#initializationOptions }
          : {}),
        capabilities: {
          textDocument: {
            // TypeScript Language Server enables push diagnostics only when
            // this legacy-but-required client capability is present.
            publishDiagnostics: {},
            diagnostic: {
              dynamicRegistration: true,
              relatedDocumentSupport: false,
            },
          },
          workspace: { diagnostics: { refreshSupport: true } },
        },
      },
      options,
    );
    if (initialized.status !== "ok") {
      this.#markBroken();
      return initialized;
    }

    this.#capabilities = initialized.value.capabilities;
    try {
      await connection.sendNotification(InitializedNotification.type, {});
    } catch {
      this.#markBroken();
      return unavailable("broken");
    }
    this.#state = "ready";
    return { status: "ok", value: undefined };
  }

  async synchronizeDocument(document: LspDocument): Promise<LspOutcome<void>> {
    const ready = this.#ready();
    if (ready) return ready;
    if (!Number.isInteger(document.version) || document.version < 0) {
      throw new TypeError(
        "LSP document versions must be non-negative integers.",
      );
    }
    const previous = this.#documents.get(document.uri);
    if (previous && document.version <= previous.version) {
      throw new TypeError(
        "LSP document versions must increase on every change.",
      );
    }
    try {
      if (!previous) {
        await this.#connection!.sendNotification(
          DidOpenTextDocumentNotification.type,
          {
            textDocument: document,
          },
        );
      } else {
        await this.#connection!.sendNotification(
          DidChangeTextDocumentNotification.type,
          {
            textDocument: { uri: document.uri, version: document.version },
            contentChanges: [{ text: document.text }],
          },
        );
      }
      this.#documents.set(document.uri, { ...document });
      return { status: "ok", value: undefined };
    } catch {
      this.#markBroken();
      return unavailable("broken");
    }
  }

  async documentDiagnostics(
    document: LspDocument,
    options: LspRequestOptions = {},
  ): Promise<LspOutcome<DocumentDiagnosticReport>> {
    // Record the push generation before didOpen/didChange so an old cached
    // notification can never be mistaken for diagnostics of these contents.
    const pushGeneration = this.#pushDiagnosticGeneration;
    const synchronized = await this.synchronizeDocument(document);
    if (synchronized.status !== "ok") return synchronized;

    if (!this.supportsDocumentDiagnostics) {
      const pushed = await this.#waitForFreshPushDiagnostics(
        document,
        pushGeneration,
        options,
      );
      if (pushed.status !== "ok") return pushed;
      return {
        status: "ok",
        value: { kind: "full", items: [...pushed.value] },
      };
    }

    const refreshGeneration = this.#diagnosticRefreshGeneration;
    const result = await this.#request<DocumentDiagnosticReport>(
      DocumentDiagnosticRequest.type,
      {
        textDocument: { uri: document.uri },
        previousResultId: this.#documentResultIds.get(document.uri),
      },
      options,
    );
    if (
      result.status === "ok" &&
      result.value.kind === "full" &&
      result.value.resultId &&
      refreshGeneration === this.#diagnosticRefreshGeneration
    ) {
      this.#documentResultIds.set(document.uri, result.value.resultId);
    }
    return result;
  }

  async workspaceDiagnostics(
    options: LspRequestOptions = {},
  ): Promise<LspOutcome<WorkspaceDiagnosticReport>> {
    const ready = this.#ready();
    if (ready) return ready;
    if (!this.supportsWorkspaceDiagnostics) return unavailable("unsupported");
    return this.#request<WorkspaceDiagnosticReport>(
      WorkspaceDiagnosticRequest.type,
      { previousResultIds: [] },
      options,
    );
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#closing = true;
    try {
      if (this.#state === "ready" && this.#connection) {
        await this.#request<void>(ShutdownRequest.type, undefined, {
          timeoutMs: Math.min(this.#requestTimeoutMs, 1_000),
        });
        await this.#connection.sendNotification(ExitNotification.type);
      }
    } catch {
      // Disposal is best effort; process termination below is the final guard.
    } finally {
      this.#connection?.end();
      this.#connection?.dispose();
      this.#state = "closed";
      try {
        this.process.kill();
      } catch {
        // A process that already exited has nothing left to clean up.
      }
    }
  }

  #ready(): LspOutcome<never> | undefined {
    if (this.#state === "ready") return undefined;
    return unavailable(this.#state === "closed" ? "closed" : "broken");
  }

  async #waitForFreshPushDiagnostics(
    document: LspDocument,
    generation: number,
    options: LspRequestOptions,
  ): Promise<LspOutcome<readonly Diagnostic[]>> {
    if (options.signal?.aborted) return unavailable("cancelled");
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    return new Promise<LspOutcome<readonly Diagnostic[]>>((resolve) => {
      let settled = false;
      let timeout: unknown;
      let quiet: unknown;
      let abortListener: (() => void) | undefined;
      const finish = (result: LspOutcome<readonly Diagnostic[]>) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) this.#clock.clearTimeout(timeout);
        if (quiet !== undefined) this.#clock.clearTimeout(quiet);
        this.#pushDiagnosticWaiters.delete(observe);
        if (abortListener)
          options.signal?.removeEventListener("abort", abortListener);
        resolve(result);
      };
      const observe = () => {
        const record = this.#pushDiagnostics.get(document.uri);
        if (
          !record ||
          record.generation <= generation ||
          (record.version !== undefined && record.version !== document.version)
        ) {
          return;
        }
        if (quiet !== undefined) this.#clock.clearTimeout(quiet);
        quiet = this.#clock.setTimeout(
          () => finish({ status: "ok", value: record.diagnostics }),
          this.#pushDiagnosticQuietMs,
        );
      };
      abortListener = () => finish(unavailable("cancelled"));
      options.signal?.addEventListener("abort", abortListener, { once: true });
      this.#pushDiagnosticWaiters.add(observe);
      observe();
      if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
        timeout = this.#clock.setTimeout(
          () => finish(unavailable("timeout")),
          timeoutMs,
        );
      }
    });
  }

  async #request<T>(
    type: Parameters<ProtocolConnection["sendRequest"]>[0],
    params: unknown,
    options: LspRequestOptions,
  ): Promise<LspOutcome<T>> {
    if (!this.#connection) return unavailable("broken");
    if (options.signal?.aborted) return unavailable("cancelled");

    const cancellation = new CancellationTokenSource();
    let cancelledByClient = false;
    let timer: unknown;
    let abortListener: (() => void) | undefined;
    const request = this.#connection
      .sendRequest(type as never, params as never, cancellation.token)
      .then((value) => ({ status: "ok", value: value as T }) as LspOutcome<T>)
      .catch(() => {
        if (!cancelledByClient) this.#markBroken();
        return unavailable(
          cancelledByClient ? "cancelled" : "broken",
        ) as LspOutcome<T>;
      });

    return new Promise<LspOutcome<T>>((resolve) => {
      let settled = false;
      const finish = (result: LspOutcome<T>) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.#clock.clearTimeout(timer);
        if (abortListener)
          options.signal?.removeEventListener("abort", abortListener);
        cancellation.dispose();
        resolve(result);
      };
      abortListener = () => {
        cancelledByClient = true;
        cancellation.cancel();
        finish(unavailable("cancelled"));
      };
      options.signal?.addEventListener("abort", abortListener, { once: true });
      const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
      if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
        timer = this.#clock.setTimeout(() => {
          cancelledByClient = true;
          cancellation.cancel();
          finish(unavailable("timeout"));
        }, timeoutMs);
      }
      void request.then(finish);
    });
  }

  #markBroken(): void {
    if (!this.#closing && this.#state !== "closed") this.#state = "broken";
  }
}

function registrationProvidesWorkspaceDiagnostics(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).workspaceDiagnostics === true
  );
}

function unavailable(reason: LspAvailabilityReason): LspOutcome<never> {
  return { status: "unavailable", reason };
}
