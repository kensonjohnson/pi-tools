import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { LspDiagnosticInspector } from "./inspect.ts";
import type { LspChildProcess, LspClock } from "./lsp-client.ts";
import { LspServerManager } from "./server-manager.ts";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-lsp-server.mjs",
);

class TestClock implements LspClock {
  #timers = new Map<number, () => void>();
  #nextTimer = 0;

  setTimeout(callback: () => void, _milliseconds: number): unknown {
    const timer = this.#nextTimer;
    this.#nextTimer += 1;
    this.#timers.set(timer, callback);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#timers.delete(handle);
  }

  get pendingTimers(): number {
    return this.#timers.size;
  }

  runNextTimer(): void {
    const next = this.#timers.entries().next().value as
      [number, () => void] | undefined;
    if (!next) throw new Error("No timer is pending.");
    this.#timers.delete(next[0]);
    next[1]();
  }
}

async function createServerManager(
  options: {
    workspace?: boolean;
    delay?: boolean;
    timeoutMs?: number;
    pushOnly?: boolean;
    batchRace?: boolean;
    emptyPullKind?: boolean;
    pushDelayMs?: number;
    pushVersioned?: boolean;
    pushNone?: boolean;
    dynamicDiagnostics?: boolean;
    dynamicWorkspaceDiagnostics?: boolean;
    suppressDynamicRegistration?: boolean;
    refresh?: boolean;
    documentErrorOnce?: boolean;
    clock?: LspClock;
    stalePushDelayMs?: number;
    pushDiagnosticQuietMs?: number;
    dynamicRegistrationWaitMs?: number;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-lsp-client-"));
  const logPath = join(directory, "server.log");
  const processes: ChildProcess[] = [];
  const manager = new LspServerManager({
    requestTimeoutMs: options.timeoutMs ?? 1_000,
    pushDiagnosticQuietMs: options.pushDiagnosticQuietMs,
    dynamicRegistrationWaitMs: options.dynamicRegistrationWaitMs,
    clock: options.clock,
    launcher: () => {
      const child = spawn(process.execPath, [fixture], {
        cwd: directory,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          FAKE_LSP_LOG: logPath,
          FAKE_LSP_WORKSPACE: options.workspace ? "1" : "0",
          FAKE_LSP_DELAY: options.delay ? "1" : "0",
          FAKE_LSP_PUSH_ONLY: options.pushOnly ? "1" : "0",
          FAKE_LSP_BATCH_RACE: options.batchRace ? "1" : "0",
          FAKE_LSP_EMPTY_PULL_KIND: options.emptyPullKind ? "1" : "0",
          FAKE_LSP_PUSH_DELAY: String(options.pushDelayMs ?? 0),
          FAKE_LSP_PUSH_VERSIONED: options.pushVersioned ? "1" : "0",
          FAKE_LSP_PUSH_NONE: options.pushNone ? "1" : "0",
          FAKE_LSP_DYNAMIC: options.dynamicDiagnostics ? "1" : "0",
          FAKE_LSP_DYNAMIC_WORKSPACE: options.dynamicWorkspaceDiagnostics
            ? "1"
            : "0",
          FAKE_LSP_SUPPRESS_DYNAMIC_REGISTRATION:
            options.suppressDynamicRegistration ? "1" : "0",
          FAKE_LSP_REFRESH: options.refresh ? "1" : "0",
          FAKE_LSP_DOCUMENT_ERROR_ONCE: options.documentErrorOnce ? "1" : "0",
          FAKE_LSP_STALE_PUSH_DELAY:
            options.stalePushDelayMs === undefined
              ? "unset"
              : String(options.stalePushDelayMs),
        },
      });
      // The production launcher and LspClient both consume these; retain one
      // here because this injected test launcher deliberately bypasses it.
      child.on("error", () => {});
      processes.push(child);
      return child as LspChildProcess;
    },
  });
  return {
    directory,
    logPath,
    manager,
    processes,
    async dispose() {
      await manager.close();
      for (const child of processes) child.kill();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function waitForLog(
  logPath: string,
  expected: string,
): Promise<string[]> {
  return waitForLogCount(logPath, expected, 1);
}

async function waitForLogCount(
  logPath: string,
  expected: string,
  count: number,
): Promise<string[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lines = await readLog(logPath);
    if (lines.filter((line) => line === expected).length >= count) {
      return lines;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${count} fake '${expected}' events.`);
}

async function waitForDiagnosticCount(
  client: { getDiagnostics(uri: string): readonly unknown[] },
  uri: string,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (client.getDiagnostics(uri).length === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${expected} fake diagnostics.`);
}

async function readLog(logPath: string): Promise<string[]> {
  try {
    return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("manager reuses a framed stdio client and synchronizes diagnostics", async () => {
  const server = await createServerManager({ workspace: true });
  try {
    const request = {
      projectRoot: server.directory,
      filePath: "source.ts",
      executablePath: "/managed/fake-language-server",
    };
    const first = await server.manager.getForFile(request);
    const second = await server.manager.getForFile(request);
    assert.equal(first.status, "ok");
    assert.equal(second.status, "ok");
    if (first.status !== "ok" || second.status !== "ok") return;
    assert.equal(first.value, second.value);
    assert.equal(server.processes.length, 1);

    const uri = pathToFileURL(join(server.directory, "source.ts")).toString();
    assert.deepEqual(
      await first.value.synchronizeDocument({
        uri,
        languageId: "typescript",
        text: "const first = 1;",
        version: 1,
      }),
      { status: "ok", value: undefined },
    );
    await waitForLog(server.logPath, "publish:1:1");
    assert.equal(first.value.getDiagnostics(uri).length, 1);

    await first.value.synchronizeDocument({
      uri,
      languageId: "typescript",
      text: "const second = 2;",
      version: 2,
    });
    await waitForLog(server.logPath, "publish:2:0");
    assert.deepEqual(first.value.getDiagnostics(uri), []);

    const document = await first.value.documentDiagnostics({
      uri,
      languageId: "typescript",
      text: "const second = 2;",
      version: 3,
    });
    assert.deepEqual(document, {
      status: "ok",
      value: { kind: "full", resultId: "fake-result", items: [] },
    });
    assert.deepEqual(await first.value.workspaceDiagnostics(), {
      status: "ok",
      value: { items: [] },
    });
    const events = await waitForLog(server.logPath, "workspace");
    assert.ok(events.indexOf("initialize") < events.indexOf("initialized"));
    assert.ok(events.includes("initialize-pull:none"));
    assert.ok(events.includes("initialize-push:true"));
  } finally {
    await server.dispose();
  }
});

test("a server response error leaves the client ready for the next inspection", async () => {
  const server = await createServerManager({ documentErrorOnce: true });
  try {
    const result = await server.manager.getForFile({
      projectRoot: server.directory,
      filePath: "source.go",
      executablePath: "/managed/fake-language-server",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const inspector = new LspDiagnosticInspector({
      async resolveFile() {
        return {
          status: "ok",
          server: { catalogId: "go", client: result.value },
        };
      },
      async resolveWorkspace() {
        return [];
      },
    });

    const rejected = await inspector.inspect(server.directory, {
      mode: "file",
      path: "source.go",
      contents: "package source\n",
    });
    assert.equal(rejected.status, "unavailable");
    assert.deepEqual(rejected.availability, [
      {
        status: "unavailable",
        catalogId: "go",
        message: "no package metadata for fake file",
      },
    ]);
    assert.equal(result.value.state, "ready");

    const subsequent = await inspector.inspect(server.directory, {
      mode: "file",
      path: "source.go",
      contents: "package source\n",
    });
    assert.equal(subsequent.status, "ok");
    await waitForLog(server.logPath, "document-error");
  } finally {
    await server.dispose();
  }
});

test("closes each transient Go document before the target document request", async () => {
  const server = await createServerManager({
    batchRace: true,
    timeoutMs: 2_000,
  });
  try {
    const result = await server.manager.getForFile({
      projectRoot: server.directory,
      filePath: "internal/takeoff/seed.go",
      executablePath: "/managed/fake-language-server",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const inspector = new LspDiagnosticInspector({
      async resolveFile() {
        return {
          status: "ok",
          server: { catalogId: "go", client: result.value },
        };
      },
      async resolveWorkspace() {
        return [];
      },
    });

    const batch = Array.from({ length: 33 }, (_, index) =>
      inspector.inspect(server.directory, {
        mode: "file",
        path: `internal/takeoff/file-${index}.go`,
        contents: "package takeoff\\n",
      }),
    );
    // Queue the target before the batch settles. It must wait behind each
    // transient document rather than relying on a quiet server after the batch.
    const target = inspector.inspect(server.directory, {
      mode: "file",
      path: "internal/takeoff/splaytree_test.go",
      contents: "package takeoff\\n",
    });
    const [targetResult, ...batchResults] = await Promise.all([
      target,
      ...batch,
    ]);
    for (const inspection of batchResults) {
      assert.equal(inspection.status, "ok");
      if (inspection.status === "ok") {
        assert.equal(inspection.diagnostics.length, 0);
      }
    }
    assert.equal(targetResult.status, "ok");
    if (targetResult.status !== "ok") return;
    assert.equal(targetResult.diagnostics.length, 2);

    const targetUri = pathToFileURL(
      join(server.directory, "internal/takeoff/splaytree_test.go"),
    ).toString();
    await waitForLog(server.logPath, `close:${targetUri}`);
    const events = await readLog(server.logPath);
    assert.equal(events.includes("document-open:1"), true);
    assert.equal(
      events.filter((event) => event === "document-target:2").length,
      1,
    );
    assert.equal(
      events.filter((event) => event.startsWith("open:")).length,
      34,
    );
    assert.equal(
      events.filter((event) => event.startsWith("close:")).length,
      34,
    );
  } finally {
    await server.dispose();
  }
});

test("empty pull kinds render rangeint hints", async () => {
  const server = await createServerManager({
    batchRace: true,
    emptyPullKind: true,
  });
  try {
    const result = await server.manager.getForFile({
      projectRoot: server.directory,
      filePath: "internal/takeoff/splaytree_test.go",
      executablePath: "/managed/fake-language-server",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const inspector = new LspDiagnosticInspector({
      async resolveFile() {
        return {
          status: "ok",
          server: { catalogId: "go", client: result.value },
        };
      },
      async resolveWorkspace() {
        return [];
      },
    });

    const inspection = await inspector.inspect(server.directory, {
      mode: "file",
      path: "internal/takeoff/splaytree_test.go",
      contents: "package takeoff\\n",
    });
    assert.equal(inspection.status, "ok");
    if (inspection.status !== "ok") return;
    assert.deepEqual(
      inspection.diagnostics.map(({ diagnostic }) => diagnostic.message),
      ["rangeint diagnostic 1", "rangeint diagnostic 2"],
    );
  } finally {
    await server.dispose();
  }
});

test("push-only diagnostics wait for a post-synchronization delayed update and clean clear", async () => {
  const server = await createServerManager({
    pushOnly: true,
    pushDelayMs: 25,
    pushDiagnosticQuietMs: 5,
  });
  try {
    const result = await server.manager.getForFile({
      projectRoot: server.directory,
      filePath: "source.ts",
      executablePath: "/managed/fake-language-server",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const uri = pathToFileURL(join(server.directory, "source.ts")).toString();

    const first = await result.value.documentDiagnostics({
      uri,
      languageId: "typescript",
      text: "const problem = 1;",
      version: 1,
    });
    assert.deepEqual(first, {
      status: "ok",
      value: {
        kind: "full",
        items: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            severity: 1,
            message: "first diagnostic",
          },
        ],
      },
    });
    await waitForLog(server.logPath, "publish:1:1");

    const cleared = await result.value.documentDiagnostics({
      uri,
      languageId: "typescript",
      text: "const clean = 1;",
      version: 2,
    });
    assert.deepEqual(cleared, {
      status: "ok",
      value: { kind: "full", items: [] },
    });
    await waitForLog(server.logPath, "publish:2:0");
  } finally {
    await server.dispose();
  }
});

test("default push quiet window rejects a delayed unversioned old-content publish", async () => {
  const server = await createServerManager({
    pushOnly: true,
    pushDelayMs: 800,
    stalePushDelayMs: 300,
    timeoutMs: 4_000,
  });
  try {
    const result = await server.manager.getForFile({
      projectRoot: server.directory,
      filePath: "source.ts",
      executablePath: "/managed/fake-language-server",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const uri = pathToFileURL(join(server.directory, "source.ts")).toString();
    await result.value.synchronizeDocument({
      uri,
      languageId: "typescript",
      text: "const old = 1;",
      version: 1,
    });
    await waitForDiagnosticCount(result.value, uri, 1);

    const fresh = await result.value.documentDiagnostics({
      uri,
      languageId: "typescript",
      text: "const current = 2;",
      version: 2,
    });
    assert.deepEqual(fresh, {
      status: "ok",
      value: { kind: "full", items: [] },
    });
  } finally {
    await server.dispose();
  }
});

test("versioned pushes reject stale pre-change diagnostics and missing updates time out", async () => {
  const server = await createServerManager({
    pushOnly: true,
    pushVersioned: true,
    pushDiagnosticQuietMs: 0,
    timeoutMs: 100,
  });
  try {
    const result = await server.manager.getForFile({
      projectRoot: server.directory,
      filePath: "source.ts",
      executablePath: "/managed/fake-language-server",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const uri = pathToFileURL(join(server.directory, "source.ts")).toString();
    await result.value.synchronizeDocument({
      uri,
      languageId: "typescript",
      text: "const old = 1;",
      version: 1,
    });
    await waitForLog(server.logPath, "publish:1:1");
    const fresh = await result.value.documentDiagnostics({
      uri,
      languageId: "typescript",
      text: "const current = 2;",
      version: 2,
    });
    assert.deepEqual(fresh, {
      status: "ok",
      value: { kind: "full", items: [] },
    });

    await server.dispose();
    const noPush = await createServerManager({
      pushOnly: true,
      pushNone: true,
      timeoutMs: 200,
      pushDiagnosticQuietMs: 0,
    });
    try {
      const noPushResult = await noPush.manager.getForFile({
        projectRoot: noPush.directory,
        filePath: "source.ts",
        executablePath: "/managed/fake-language-server",
      });
      assert.equal(noPushResult.status, "ok");
      if (noPushResult.status !== "ok") return;
      assert.deepEqual(
        await noPushResult.value.documentDiagnostics(
          {
            uri: pathToFileURL(join(noPush.directory, "source.ts")).toString(),
            languageId: "typescript",
            text: "const noUpdate = 1;",
            version: 1,
          },
          { timeoutMs: 20 },
        ),
        { status: "unavailable", reason: "timeout" },
      );
    } finally {
      await noPush.dispose();
    }
  } finally {
    await server.dispose();
  }
});

async function assertPromptBroken(pending: Promise<unknown>): Promise<void> {
  const stillWaiting = Symbol("still waiting");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      pending,
      new Promise<typeof stillWaiting>((resolve) => {
        timeout = setTimeout(() => resolve(stillWaiting), 100);
      }),
    ]);
    assert.notEqual(outcome, stillWaiting, "waiter did not wake after exit");
    assert.deepEqual(outcome, { status: "unavailable", reason: "broken" });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

test("a broken server wakes a pending dynamic diagnostic registration", async () => {
  const clock = new TestClock();
  const server = await createServerManager({
    clock,
    dynamicDiagnostics: true,
    suppressDynamicRegistration: true,
    pushNone: true,
    dynamicRegistrationWaitMs: 1_000,
    timeoutMs: 1_000,
  });
  try {
    const result = await server.manager.getForFile({
      projectRoot: server.directory,
      filePath: "source.py",
      executablePath: "/managed/fake-language-server",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const uri = pathToFileURL(join(server.directory, "source.py")).toString();
    const pending = result.value.documentDiagnostics({
      uri,
      languageId: "python",
      text: "x = 1",
      version: 1,
    });
    await waitForLog(server.logPath, "open:1:x = 1");
    assert.equal(clock.pendingTimers, 1);
    server.processes[0]?.kill();
    await assertPromptBroken(pending);
  } finally {
    await server.dispose();
  }
});

test("a broken server wakes a pending push diagnostic wait", async () => {
  const clock = new TestClock();
  const server = await createServerManager({
    clock,
    pushOnly: true,
    pushNone: true,
    dynamicRegistrationWaitMs: 0,
    timeoutMs: 1_000,
  });
  try {
    const result = await server.manager.getForFile({
      projectRoot: server.directory,
      filePath: "source.ts",
      executablePath: "/managed/fake-language-server",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const uri = pathToFileURL(join(server.directory, "source.ts")).toString();
    const pending = result.value.documentDiagnostics({
      uri,
      languageId: "typescript",
      text: "const pending = 1;",
      version: 1,
    });
    await waitForLog(server.logPath, "open:1:const pending = 1;");
    assert.equal(clock.pendingTimers, 1);
    clock.runNextTimer();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clock.pendingTimers, 1);
    server.processes[0]?.kill();
    await assertPromptBroken(pending);
  } finally {
    await server.dispose();
  }
});

test("dynamic registration is ready before the first document pull", async () => {
  const server = await createServerManager({
    dynamicDiagnostics: true,
    dynamicRegistrationWaitMs: 100,
    timeoutMs: 500,
  });
  try {
    const result = await server.manager.getForFile({
      projectRoot: server.directory,
      filePath: "source.py",
      executablePath: "/managed/fake-language-server",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const uri = pathToFileURL(join(server.directory, "source.py")).toString();
    assert.deepEqual(
      await result.value.documentDiagnostics({
        uri,
        languageId: "python",
        text: "x = 1",
        version: 1,
      }),
      {
        status: "ok",
        value: { kind: "full", resultId: "fake-result", items: [] },
      },
    );
    assert.equal(result.value.supportsDocumentDiagnostics, true);
    await waitForLog(server.logPath, "dynamic-registered");
  } finally {
    await server.dispose();
  }
});

test("dynamic document diagnostics and refresh invalidate prior pull result ids", async () => {
  const server = await createServerManager({
    dynamicDiagnostics: true,
    dynamicWorkspaceDiagnostics: true,
    refresh: true,
  });
  try {
    const result = await server.manager.getForFile({
      projectRoot: server.directory,
      filePath: "source.py",
      executablePath: "/managed/fake-language-server",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    await waitForLog(server.logPath, "dynamic-registered");
    assert.equal(result.value.supportsDocumentDiagnostics, true);
    assert.equal(result.value.supportsWorkspaceDiagnostics, true);
    assert.deepEqual(await result.value.workspaceDiagnostics(), {
      status: "ok",
      value: { items: [] },
    });
    await waitForLog(server.logPath, "workspace");
    const uri = pathToFileURL(join(server.directory, "source.py")).toString();
    assert.equal(
      (
        await result.value.documentDiagnostics({
          uri,
          languageId: "python",
          text: "x = 1",
          version: 1,
        })
      ).status,
      "ok",
    );
    await waitForLog(server.logPath, "refresh-ack");
    assert.equal(
      (
        await result.value.documentDiagnostics({
          uri,
          languageId: "python",
          text: "x = 2",
          version: 2,
        })
      ).status,
      "ok",
    );
    const events = await waitForLog(server.logPath, "document-previous:none");
    assert.equal(
      events.filter((event) => event === "document-previous:none").length,
      2,
    );
  } finally {
    await server.dispose();
  }
});

test("workspace diagnostics stay explicit when a server does not support them", async () => {
  const server = await createServerManager();
  try {
    const result = await server.manager.getForFile({
      projectRoot: server.directory,
      filePath: "source.py",
      executablePath: "/managed/fake-language-server",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(await result.value.workspaceDiagnostics(), {
      status: "unavailable",
      reason: "unsupported",
    });
    assert.equal((await readLog(server.logPath)).includes("workspace"), false);
  } finally {
    await server.dispose();
  }
});

test("a queued document request times out without opening its document", async () => {
  const server = await createServerManager({ delay: true, timeoutMs: 1_000 });
  try {
    const result = await server.manager.getForFile({
      projectRoot: server.directory,
      filePath: "source.go",
      executablePath: "/managed/fake-language-server",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const activeUri = pathToFileURL(
      join(server.directory, "active.go"),
    ).toString();
    const queuedUri = pathToFileURL(
      join(server.directory, "queued.go"),
    ).toString();
    const controller = new AbortController();
    const active = result.value.documentDiagnostics(
      { uri: activeUri, languageId: "go", text: "package active", version: 1 },
      { signal: controller.signal },
    );
    await waitForLog(server.logPath, `document:${activeUri}`);

    const queued = await result.value.documentDiagnostics(
      { uri: queuedUri, languageId: "go", text: "package queued", version: 1 },
      { timeoutMs: 10 },
    );
    assert.deepEqual(queued, { status: "unavailable", reason: "timeout" });
    assert.equal(
      (await readLog(server.logPath)).includes("open:1:package queued"),
      false,
    );

    controller.abort();
    assert.deepEqual(await active, {
      status: "unavailable",
      reason: "cancelled",
    });
  } finally {
    await server.dispose();
  }
});

test("request abort and timeout bridge to protocol cancellation", async () => {
  const server = await createServerManager({ delay: true, timeoutMs: 1_000 });
  try {
    const result = await server.manager.getForFile({
      projectRoot: server.directory,
      filePath: "source.go",
      executablePath: "/managed/fake-language-server",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    await waitForLog(server.logPath, "initialize-pull:true");
    const uri = pathToFileURL(join(server.directory, "source.go")).toString();
    const controller = new AbortController();
    const pending = result.value.documentDiagnostics(
      { uri, languageId: "go", text: "package p", version: 1 },
      { signal: controller.signal },
    );
    await waitForLog(server.logPath, `document:${uri}`);
    controller.abort();
    assert.deepEqual(await pending, {
      status: "unavailable",
      reason: "cancelled",
    });
    await waitForLog(server.logPath, "cancel");

    const timedOut = await result.value.documentDiagnostics(
      { uri, languageId: "go", text: "package p", version: 2 },
      { timeoutMs: 10 },
    );
    assert.deepEqual(timedOut, { status: "unavailable", reason: "timeout" });
  } finally {
    await server.dispose();
  }
});

test("the default stdio launcher consumes missing-executable errors", async () => {
  const manager = new LspServerManager({ requestTimeoutMs: 100 });
  try {
    assert.deepEqual(
      await manager.getOrStart({
        projectRoot: process.cwd(),
        catalogId: "typescript",
        executablePath: "/definitely/not/a/language-server",
      }),
      { status: "unavailable", reason: "broken" },
    );
  } finally {
    await manager.close();
  }
});

test("a broken launch is typed, cached, and retried only at an explicit boundary", async () => {
  let launches = 0;
  const manager = new LspServerManager({
    launcher: () => {
      launches += 1;
      throw new Error("missing executable");
    },
  });
  const request = {
    projectRoot: process.cwd(),
    catalogId: "typescript" as const,
    executablePath: "/managed/missing-server",
  };
  assert.deepEqual(await manager.getOrStart(request), {
    status: "unavailable",
    reason: "broken",
  });
  assert.deepEqual(await manager.getOrStart(request), {
    status: "unavailable",
    reason: "broken",
  });
  assert.equal(launches, 1);
  await manager.retry(request);
  assert.equal(launches, 2);
  await manager.close();
});
