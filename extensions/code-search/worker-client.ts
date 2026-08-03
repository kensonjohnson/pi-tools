import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  CODE_SEARCH_PROTOCOL_VERSION,
  type CodeSearchSymbol,
  type CodeSearchWorkerRequest,
  type CodeSearchWorkerResponse,
  type CodeSearchWorkerStatus,
} from "./worker-protocol.ts";

export type RefreshOptions = {
  root: string;
  additionalIgnores: string;
  maxFileBytes?: number;
  signal?: AbortSignal;
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

export class CodeSearchWorkerClient {
  private readonly worker = new Worker(
    new URL("./worker.ts", import.meta.url),
    {
      // Do not inherit Pi/test `--input-type`: it is invalid for worker files.
      execArgv: ["--experimental-strip-types"],
    },
  );
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;
  private failure: Error | undefined;

  constructor() {
    this.worker.on("message", (message: unknown) => {
      if (!isWorkerResponse(message)) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
    });
    this.worker.on("error", (error) => {
      this.failure = error;
      this.failPending(error);
    });
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.failure = new Error(
          `Code-search worker exited with code ${code}.`,
        );
        this.failPending(this.failure);
      }
    });
  }

  async initialize(
    storagePath: string,
    root: string,
  ): Promise<CodeSearchWorkerStatus> {
    return this.requestStatus("initialize", { storagePath, root });
  }

  async status(): Promise<CodeSearchWorkerStatus> {
    return this.requestStatus("status");
  }

  async refresh(options: RefreshOptions): Promise<CodeSearchWorkerStatus> {
    const { signal, ...request } = options;
    return this.requestStatus("refresh", request, signal);
  }

  async validate(options: RefreshOptions): Promise<CodeSearchWorkerStatus> {
    const { signal, ...request } = options;
    return this.requestStatus("validate", request, signal);
  }

  async watch(
    options: Omit<RefreshOptions, "signal"> & { enabled: boolean },
  ): Promise<CodeSearchWorkerStatus> {
    return this.requestStatus("watch", options);
  }

  async searchSymbols(options: {
    query: string;
    limit: number;
    path?: string;
    kind?: string;
    signal?: AbortSignal;
  }): Promise<CodeSearchSymbol[]> {
    const { signal, ...request } = options;
    return (await this.request(
      "searchSymbols",
      request,
      signal,
    )) as CodeSearchSymbol[];
  }

  async fileSymbols(
    path: string,
    signal?: AbortSignal,
  ): Promise<CodeSearchSymbol[]> {
    return (await this.request(
      "fileSymbols",
      { path },
      signal,
    )) as CodeSearchSymbol[];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      if (!this.failure) await this.request("close");
    } finally {
      this.closed = true;
      this.failPending(new Error("Code-search worker closed."));
      await this.worker.terminate();
    }
  }

  private async requestStatus(
    type: "initialize" | "status" | "refresh" | "validate" | "watch",
    data: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<CodeSearchWorkerStatus> {
    return (await this.request(type, data, signal)) as CodeSearchWorkerStatus;
  }

  private request(
    type: Exclude<CodeSearchWorkerRequest["type"], "cancel">,
    data: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed && type !== "close") {
      return Promise.reject(new Error("Code-search worker is closed."));
    }
    if (this.failure) return Promise.reject(this.failure);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        this.worker.postMessage({
          version: CODE_SEARCH_PROTOCOL_VERSION,
          type: "cancel",
          requestId: id,
        } satisfies CodeSearchWorkerRequest);
        reject(new Error("Code-search request cancelled."));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (result) => {
          settled = true;
          signal?.removeEventListener("abort", abort);
          resolve(result);
        },
        reject: (error) => {
          settled = true;
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.worker.postMessage({
        version: CODE_SEARCH_PROTOCOL_VERSION,
        id,
        type,
        ...data,
      });
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function isWorkerResponse(value: unknown): value is CodeSearchWorkerResponse {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { version?: unknown }).version === CODE_SEARCH_PROTOCOL_VERSION &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { ok?: unknown }).ok === "boolean",
  );
}
