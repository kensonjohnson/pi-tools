import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import type { LspChildProcess } from "./lsp-client.ts";
import { LspServerManager } from "./server-manager.ts";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-lsp-server.mjs",
);

async function createServerManager(
  options: {
    workspace?: boolean;
    delay?: boolean;
    timeoutMs?: number;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-lsp-client-"));
  const logPath = join(directory, "server.log");
  const processes: ChildProcess[] = [];
  const manager = new LspServerManager({
    requestTimeoutMs: options.timeoutMs ?? 1_000,
    launcher: () => {
      const child = spawn(process.execPath, [fixture], {
        cwd: directory,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          FAKE_LSP_LOG: logPath,
          FAKE_LSP_WORKSPACE: options.workspace ? "1" : "0",
          FAKE_LSP_DELAY: options.delay ? "1" : "0",
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lines = await readLog(logPath);
    if (lines.includes(expected)) return lines;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for fake LSP event '${expected}'.`);
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
    await waitForLog(server.logPath, "open:1:const first = 1;");
    assert.equal(first.value.getDiagnostics(uri).length, 1);

    await first.value.synchronizeDocument({
      uri,
      languageId: "typescript",
      text: "const second = 2;",
      version: 2,
    });
    await waitForLog(server.logPath, "change:2:const second = 2;");
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
