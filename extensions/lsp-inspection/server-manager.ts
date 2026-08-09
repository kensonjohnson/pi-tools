import { isAbsolute, relative, resolve } from "node:path";
import {
  findLspCatalogForFile,
  getLspCatalogDescriptor,
  isLspCatalogId,
  type LspCatalogDescriptor,
  type LspCatalogId,
} from "./catalog.ts";
import {
  launchLspServer,
  LspClient,
  type LspChildProcess,
  type LspClock,
  type LspOutcome,
} from "./lsp-client.ts";

export type LspServerLaunchRequest = {
  rootPath: string;
  descriptor: LspCatalogDescriptor;
  executablePath: string;
  arguments: readonly string[];
};

export type LspServerLauncher = (
  request: LspServerLaunchRequest,
) => LspChildProcess | Promise<LspChildProcess>;

export type LspManagedServerRequest = {
  projectRoot: string;
  catalogId?: LspCatalogId;
  filePath?: string;
  executablePath: string;
  arguments?: readonly string[];
};

export type LspServerManagerOptions = {
  launcher?: LspServerLauncher;
  clock?: LspClock;
  requestTimeoutMs?: number;
};

type ConnectionRecord = {
  client?: LspClient;
  result: Promise<LspOutcome<LspClient>>;
};

/**
 * Owns at most one LSP process for each normalized project-root/catalog pair.
 * A broken record intentionally remains cached until close() or retry() creates
 * an explicit lifecycle boundary, preventing tool calls from spawn-looping.
 */
export class LspServerManager {
  #connections = new Map<string, ConnectionRecord>();
  #launcher: LspServerLauncher;
  #clock: LspClock | undefined;
  #requestTimeoutMs: number | undefined;

  constructor(options: LspServerManagerOptions = {}) {
    this.#launcher = options.launcher ?? defaultLauncher;
    this.#clock = options.clock;
    this.#requestTimeoutMs = options.requestTimeoutMs;
  }

  async getOrStart(
    request: LspManagedServerRequest,
  ): Promise<LspOutcome<LspClient>> {
    const resolved = resolveManagedRequest(request);
    if (resolved.status !== "ok") return resolved;
    const key = `${resolved.value.rootPath}\u0000${resolved.value.descriptor.id}`;
    const existing = this.#connections.get(key);
    if (existing) return existing.result;

    const record: ConnectionRecord = {
      result: this.#start(resolved.value),
    };
    this.#connections.set(key, record);
    record.result = record.result.then((result) => {
      if (result.status === "ok") record.client = result.value;
      return result;
    });
    return record.result;
  }

  /** Resolves a catalog only when a root-contained file is in the reviewed list. */
  async getForFile(
    request: Omit<LspManagedServerRequest, "catalogId"> & { filePath: string },
  ): Promise<LspOutcome<LspClient>> {
    return this.getOrStart(request);
  }

  /** Drops one cached state after closing it, permitting an explicit retry. */
  async retry(
    request: LspManagedServerRequest,
  ): Promise<LspOutcome<LspClient>> {
    const resolved = resolveManagedRequest(request);
    if (resolved.status !== "ok") return resolved;
    const key = `${resolved.value.rootPath}\u0000${resolved.value.descriptor.id}`;
    const previous = this.#connections.get(key);
    this.#connections.delete(key);
    if (previous) {
      const result = await previous.result;
      if (result.status === "ok") await result.value.close();
    }
    return this.getOrStart(request);
  }

  async close(): Promise<void> {
    const records = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(
      records.map(async (record) => {
        const result = await record.result;
        if (result.status === "ok") await result.value.close();
      }),
    );
  }

  get size(): number {
    return this.#connections.size;
  }

  async #start(
    request: ResolvedManagedRequest,
  ): Promise<LspOutcome<LspClient>> {
    let process: LspChildProcess;
    try {
      process = await this.#launcher({
        rootPath: request.rootPath,
        descriptor: request.descriptor,
        executablePath: request.executablePath,
        arguments: request.arguments,
      });
    } catch {
      return unavailable("broken");
    }
    const client = new LspClient({
      rootPath: request.rootPath,
      process,
      clock: this.#clock,
      requestTimeoutMs: this.#requestTimeoutMs,
    });
    const initialized = await client.initialize();
    if (initialized.status !== "ok") {
      await client.close();
      return initialized;
    }
    return { status: "ok", value: client };
  }
}

type ResolvedManagedRequest = {
  rootPath: string;
  descriptor: LspCatalogDescriptor;
  executablePath: string;
  arguments: readonly string[];
};

function resolveManagedRequest(
  request: LspManagedServerRequest,
): LspOutcome<ResolvedManagedRequest> {
  if (!isAbsolute(request.projectRoot) || !isAbsolute(request.executablePath)) {
    return unavailable("unconfigured");
  }
  const rootPath = resolve(request.projectRoot);
  const descriptor = resolveDescriptor(request, rootPath);
  if (!descriptor) return unavailable("unconfigured");
  return {
    status: "ok",
    value: {
      rootPath,
      descriptor,
      executablePath: resolve(request.executablePath),
      arguments: request.arguments ?? descriptor.executable.arguments,
    },
  };
}

function resolveDescriptor(
  request: LspManagedServerRequest,
  rootPath: string,
): LspCatalogDescriptor | undefined {
  if (request.catalogId) {
    return isLspCatalogId(request.catalogId)
      ? getLspCatalogDescriptor(request.catalogId)
      : undefined;
  }
  if (!request.filePath) return undefined;
  const filePath = resolve(rootPath, request.filePath);
  const fromRoot = relative(rootPath, filePath);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return undefined;
  return findLspCatalogForFile(filePath);
}

function defaultLauncher(
  request: LspServerLaunchRequest,
): LspChildProcess | Promise<LspChildProcess> {
  return launchLspServer({
    command: request.executablePath,
    arguments: request.arguments,
    cwd: request.rootPath,
  });
}

function unavailable<T>(reason: "unconfigured" | "broken"): LspOutcome<T> {
  return { status: "unavailable", reason };
}
