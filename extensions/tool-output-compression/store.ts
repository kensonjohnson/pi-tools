import { randomUUID } from "node:crypto";
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export const STORE_SCHEMA_VERSION = 1;
export const DEFAULT_STORAGE_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_STORAGE_RETENTION_DAYS = 30;
export const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
export const DEFAULT_RETRIEVAL_MAX_BYTES = 48 * 1024;
export const MAX_RETRIEVAL_MAX_BYTES = 48 * 1024;

export type StorageSettings = {
  path: string;
  maxBytes: number;
  retentionDays: number;
  maxOutputBytes: number;
  retrievalMaxBytes: number;
};

export type StoredToolOutput = {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  contentHash: string;
  content: string;
  contentBytes: number;
  createdAtMs: number;
  expiresAtMs: number;
};

export type StoreOutputInput = Omit<StoredToolOutput, "id" | "contentBytes"> & {
  id?: string;
};

export type RetrievedToolOutput = {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  contentHash: string;
  contentBytes: number;
  createdAtMs: number;
  expiresAtMs: number;
  content: string;
  offset: number;
  nextOffset?: number;
};

export type StorageStats = {
  databaseBytes: number;
  storedBytes: number;
  outputCount: number;
  expiredCount: number;
  maxBytes: number;
  retentionDays: number;
};

export type ToolOutputStoreOptions = {
  busyTimeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  now?: () => number;
};

export class StorageQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageQuotaError";
  }
}

export class StorageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageUnavailableError";
  }
}

export class StorageAbortedError extends Error {
  constructor() {
    super("Tool-output storage operation was cancelled.");
    this.name = "StorageAbortedError";
  }
}

export class ToolOutputStore {
  readonly settings: StorageSettings;
  private db: Database.Database | undefined;
  private initializing: Promise<void> | undefined;
  private readonly busyTimeoutMs: number;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;

  constructor(settings: StorageSettings, options: ToolOutputStoreOptions = {}) {
    this.settings = settings;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 2_000;
    this.retryAttempts = options.retryAttempts ?? 4;
    this.retryDelayMs = options.retryDelayMs ?? 25;
    this.now = options.now ?? Date.now;
  }

  async store(
    input: StoreOutputInput,
    signal?: AbortSignal,
  ): Promise<StoredToolOutput> {
    throwIfAborted(signal);
    const contentBytes = Buffer.byteLength(input.content, "utf8");
    if (contentBytes > this.settings.maxOutputBytes) {
      throw new StorageQuotaError(
        `Tool output is ${contentBytes} bytes, above the per-output limit of ${this.settings.maxOutputBytes} bytes.`,
      );
    }

    const now = this.now();
    const expiresAtMs = Math.min(
      input.expiresAtMs,
      input.createdAtMs + this.settings.retentionDays * 24 * 60 * 60 * 1_000,
    );
    if (expiresAtMs <= now) {
      throw new StorageUnavailableError("Tool output is already expired.");
    }

    const output: StoredToolOutput = {
      ...input,
      id: input.id ?? randomUUID(),
      contentBytes,
      createdAtMs: input.createdAtMs,
      expiresAtMs,
    };

    return this.withImmediateTransaction(signal, () => {
      this.pruneExpiredInTransaction(now);
      const used = this.dbReady
        .prepare(
          `SELECT COALESCE(SUM(content_bytes), 0) AS bytes FROM tool_outputs`,
        )
        .get() as { bytes: number };
      if (used.bytes + contentBytes > this.settings.maxBytes) {
        throw new StorageQuotaError(
          `Tool-output storage quota of ${this.settings.maxBytes} bytes is full.`,
        );
      }

      this.dbReady
        .prepare(
          `
            INSERT INTO tool_outputs (
              id, session_id, tool_call_id, tool_name, content_hash, content,
              content_bytes, created_at_ms, expires_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          output.id,
          output.sessionId,
          output.toolCallId,
          output.toolName,
          output.contentHash,
          output.content,
          output.contentBytes,
          output.createdAtMs,
          output.expiresAtMs,
        );

      return output;
    });
  }

  async retrieve(
    id: string,
    sessionId: string,
    options: { offset?: number; maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<RetrievedToolOutput | undefined> {
    throwIfAborted(options.signal);
    await this.initialize();
    throwIfAborted(options.signal);

    const row = this.dbReady
      .prepare(
        `
          SELECT id, session_id, tool_call_id, tool_name, content_hash, content,
                 content_bytes, created_at_ms, expires_at_ms
          FROM tool_outputs
          WHERE id = ? AND session_id = ? AND expires_at_ms > ?
        `,
      )
      .get(id, sessionId, this.now()) as StoredOutputRow | undefined;
    if (!row) return undefined;

    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const maxBytes = clampRetrievalBytes(
      options.maxBytes ?? this.settings.retrievalMaxBytes,
      this.settings.retrievalMaxBytes,
    );
    const slice = sliceUtf8(row.content, offset, maxBytes);
    return {
      id: row.id,
      sessionId: row.session_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      contentHash: row.content_hash,
      contentBytes: row.content_bytes,
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
      content: slice.content,
      offset: slice.offset,
      nextOffset: slice.nextOffset,
    };
  }

  async prune(signal?: AbortSignal): Promise<number> {
    return this.withImmediateTransaction(signal, () =>
      this.pruneExpiredInTransaction(this.now()),
    );
  }

  async stats(): Promise<StorageStats> {
    await this.initialize();
    const now = this.now();
    const row = this.dbReady
      .prepare(
        `
          SELECT
            COALESCE(SUM(content_bytes), 0) AS stored_bytes,
            COUNT(*) AS output_count,
            SUM(CASE WHEN expires_at_ms <= ? THEN 1 ELSE 0 END) AS expired_count
          FROM tool_outputs
        `,
      )
      .get(now) as {
      stored_bytes: number;
      output_count: number;
      expired_count: number | null;
    };
    return {
      databaseBytes: await databaseFileBytes(this.settings.path),
      storedBytes: row.stored_bytes,
      outputCount: row.output_count,
      expiredCount: row.expired_count ?? 0,
      maxBytes: this.settings.maxBytes,
      retentionDays: this.settings.retentionDays,
    };
  }

  async vacuum(signal?: AbortSignal): Promise<void> {
    await this.initialize();
    await this.retry(signal, () => {
      this.dbReady.exec("VACUUM");
    });
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
    this.initializing = undefined;
  }

  private get dbReady(): Database.Database {
    if (!this.db)
      throw new StorageUnavailableError("Storage is not initialized.");
    return this.db;
  }

  private async initialize(): Promise<void> {
    if (this.db) return;
    if (this.initializing) return this.initializing;

    const initializing = (async () => {
      let db: Database.Database | undefined;
      try {
        await mkdir(dirname(this.settings.path), {
          recursive: true,
          mode: 0o700,
        });
        db = new Database(this.settings.path);
        // Set this before any operation that may wait on another process.
        db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
        this.db = db;
        await this.retry(undefined, () => {
          this.dbReady.pragma("journal_mode = WAL");
          this.dbReady.pragma("synchronous = FULL");
          this.dbReady.pragma("foreign_keys = ON");
          this.migrate();
        });
        await secureStorageFiles(this.settings.path);
      } catch (error) {
        db?.close();
        this.db = undefined;
        if (error instanceof StorageUnavailableError) throw error;
        throw new StorageUnavailableError(
          "Could not initialize tool-output storage.",
          { cause: error },
        );
      }
    })();
    this.initializing = initializing;

    try {
      await initializing;
    } finally {
      if (this.initializing === initializing) this.initializing = undefined;
    }
  }

  private migrate(): void {
    const version = this.dbReady.pragma("user_version", {
      simple: true,
    }) as number;
    if (version > STORE_SCHEMA_VERSION) {
      throw new StorageUnavailableError(
        `Tool-output storage schema ${version} is newer than this extension supports.`,
      );
    }
    if (version === STORE_SCHEMA_VERSION) return;

    this.dbReady.exec("BEGIN IMMEDIATE");
    try {
      if (version < 1) {
        this.dbReady.exec(`
          CREATE TABLE IF NOT EXISTS tool_outputs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            tool_call_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            content TEXT NOT NULL,
            content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
            created_at_ms INTEGER NOT NULL,
            expires_at_ms INTEGER NOT NULL
          );
          CREATE UNIQUE INDEX IF NOT EXISTS tool_outputs_session_call
            ON tool_outputs(session_id, tool_call_id);
          CREATE INDEX IF NOT EXISTS tool_outputs_expiry
            ON tool_outputs(expires_at_ms);
          CREATE INDEX IF NOT EXISTS tool_outputs_session_hash
            ON tool_outputs(session_id, content_hash);
        `);
      }
      this.dbReady.pragma(`user_version = ${STORE_SCHEMA_VERSION}`);
      this.dbReady.exec("COMMIT");
    } catch (error) {
      rollback(this.dbReady);
      throw error;
    }
  }

  private async withImmediateTransaction<T>(
    signal: AbortSignal | undefined,
    operation: () => T,
  ): Promise<T> {
    await this.initialize();
    return this.retry(signal, () => {
      this.dbReady.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        this.dbReady.exec("COMMIT");
        return result;
      } catch (error) {
        rollback(this.dbReady);
        throw error;
      }
    });
  }

  private async retry<T>(
    signal: AbortSignal | undefined,
    operation: () => T,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
      throwIfAborted(signal);
      try {
        return operation();
      } catch (error) {
        if (!isBusyError(error) || attempt === this.retryAttempts) {
          if (isBusyError(error)) {
            throw new StorageUnavailableError(
              "Tool-output storage is busy; the original result was left unchanged.",
              { cause: error },
            );
          }
          throw error;
        }
        lastError = error;
        await delay(this.retryDelayMs * (attempt + 1), signal);
      }
    }
    throw new StorageUnavailableError("Tool-output storage is unavailable.", {
      cause: lastError,
    });
  }

  private pruneExpiredInTransaction(now: number): number {
    return this.dbReady
      .prepare(`DELETE FROM tool_outputs WHERE expires_at_ms <= ?`)
      .run(now).changes;
  }
}

type StoredOutputRow = {
  id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  content_hash: string;
  content: string;
  content_bytes: number;
  created_at_ms: number;
  expires_at_ms: number;
};

function clampRetrievalBytes(requested: number, configuredMax: number): number {
  return Math.max(
    1,
    Math.min(
      MAX_RETRIEVAL_MAX_BYTES,
      Math.floor(configuredMax),
      Math.floor(requested),
    ),
  );
}

function sliceUtf8(
  content: string,
  requestedOffset: number,
  maxBytes: number,
): { content: string; offset: number; nextOffset?: number } {
  const bytes = Buffer.from(content, "utf8");
  let start = Math.min(requestedOffset, bytes.length);
  while (start < bytes.length && isContinuationByte(bytes[start]!)) start++;

  let end = Math.min(start + maxBytes, bytes.length);
  while (end > start && end < bytes.length && isContinuationByte(bytes[end]!)) {
    end--;
  }
  if (end === start && start < bytes.length) {
    // A configured retrieval limit smaller than one code point is still safe.
    end = Math.min(bytes.length, start + utf8CodePointLength(bytes[start]!));
  }

  return {
    content: bytes.subarray(start, end).toString("utf8"),
    offset: start,
    nextOffset: end < bytes.length ? end : undefined,
  };
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

function utf8CodePointLength(firstByte: number): number {
  if ((firstByte & 0b1000_0000) === 0) return 1;
  if ((firstByte & 0b1110_0000) === 0b1100_0000) return 2;
  if ((firstByte & 0b1111_0000) === 0b1110_0000) return 3;
  return 4;
}

function rollback(db: Database.Database): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No transaction was started or SQLite already rolled it back.
  }
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    error.message.includes("SQLITE_BUSY") ||
    error.message.includes("SQLITE_LOCKED") ||
    error.message.toLowerCase().includes("database is locked")
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new StorageAbortedError();
}

function delay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StorageAbortedError());
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new StorageAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function secureStorageFiles(path: string): Promise<void> {
  await Promise.all(
    [path, `${path}-wal`, `${path}-shm`].map((file) =>
      chmod(file, 0o600).catch(() => {}),
    ),
  );
}

async function databaseFileBytes(path: string): Promise<number> {
  const files = [path, `${path}-wal`, `${path}-shm`];
  const sizes = await Promise.all(
    files.map(async (file) => {
      try {
        return (await stat(file)).size;
      } catch {
        return 0;
      }
    }),
  );
  return sizes.reduce((total, size) => total + size, 0);
}
