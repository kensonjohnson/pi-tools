import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  StorageAbortedError,
  StorageQuotaError,
  StorageUnavailableError,
  ToolOutputStore,
  type StorageSettings,
} from "./store.ts";

async function withStore(
  run: (args: {
    path: string;
    settings: StorageSettings;
    now: { value: number };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-output-store-"));
  try {
    const now = { value: 1_000 };
    const settings: StorageSettings = {
      path: join(root, "tool-output.sqlite"),
      maxBytes: 10_000,
      retentionDays: 30,
      maxOutputBytes: 5_000,
      retrievalMaxBytes: 100,
    };
    await run({ path: settings.path, settings, now });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function output(
  overrides: Partial<{
    id: string;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    contentHash: string;
    content: string;
    createdAtMs: number;
    expiresAtMs: number;
  }> = {},
) {
  return {
    sessionId: "session-a",
    toolCallId: "call-a",
    toolName: "read",
    contentHash: "hash-a",
    content: "hello 🌍 tool output",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    ...overrides,
  };
}

test("stores provenance durably with SQLite safety pragmas and bounded chunks", async () => {
  await withStore(async ({ path, settings, now }) => {
    const first = new ToolOutputStore(settings, { now: () => now.value });
    const stored = await first.store(output());
    await first.close();

    const db = new Database(path, { readonly: true });
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(db.pragma("user_version", { simple: true }), 1);
    db.close();
    assert.equal((await stat(path)).mode & 0o777, 0o600);

    // A new store instance models a reload, compaction, or session replacement.
    const resumed = new ToolOutputStore(settings, { now: () => now.value });
    const chunk = await resumed.retrieve(stored.id, "session-a", {
      maxBytes: 9,
    });
    assert.equal(chunk?.toolName, "read");
    assert.equal(chunk?.content, "hello ");
    assert.equal(chunk?.nextOffset, 6);
    assert.equal(
      (await resumed.retrieve(stored.id, "session-b")) === undefined,
      true,
    );
    const full = await resumed.retrieve(stored.id, "session-a", {
      offset: chunk?.nextOffset,
      maxBytes: 100,
    });
    assert.equal(full?.content, "🌍 tool output");
    assert.equal(full?.nextOffset, undefined);
    assert.equal((await resumed.stats()).outputCount, 1);
    await resumed.close();
  });
});

test("enforces raw-output quota and removes only expired records", async () => {
  await withStore(async ({ settings, now }) => {
    const store = new ToolOutputStore(
      { ...settings, maxBytes: 30, maxOutputBytes: 30 },
      { now: () => now.value },
    );
    await store.store(output({ content: "a".repeat(20) }));
    await assert.rejects(
      store.store(
        output({ id: "other", toolCallId: "call-b", content: "b".repeat(20) }),
      ),
      StorageQuotaError,
    );

    now.value = 10_000;
    assert.equal(await store.prune(), 1);
    assert.equal((await store.stats()).storedBytes, 0);
    await store.close();
  });
});

test("fails closed on cancellation, unavailable paths, and a bounded busy retry", async () => {
  await withStore(async ({ path, settings, now }) => {
    const controller = new AbortController();
    controller.abort();
    const store = new ToolOutputStore(settings, { now: () => now.value });
    await assert.rejects(
      store.store(output(), controller.signal),
      StorageAbortedError,
    );

    await store.stats();
    const lock = new Database(path);
    lock.exec("BEGIN IMMEDIATE");
    const contended = new ToolOutputStore(settings, {
      busyTimeoutMs: 1,
      retryAttempts: 2,
      retryDelayMs: 1,
      now: () => now.value,
    });
    await assert.rejects(
      contended.store(output({ id: "contended", toolCallId: "call-b" })),
      StorageUnavailableError,
    );
    lock.exec("ROLLBACK");
    lock.close();

    await contended.store(output({ id: "after-lock", toolCallId: "call-c" }));
    await contended.close();
    await store.close();

    const invalidPath = path.replace(
      "tool-output.sqlite",
      "not-a-database-directory",
    );
    await mkdir(invalidPath);
    const invalid = new ToolOutputStore({ ...settings, path: invalidPath });
    // A directory at the database path is an initialization failure, not a raw-output fallback.
    await assert.rejects(invalid.stats(), StorageUnavailableError);
  });
});
