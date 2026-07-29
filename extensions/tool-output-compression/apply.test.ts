import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function result(toolCallId: string, text: string) {
  return {
    type: "tool_result",
    toolCallId,
    toolName: "read",
    input: { path: "example.txt" },
    content: [{ type: "text" as const, text }],
    isError: false,
    details: { preserved: true },
  };
}

test("apply mode stores an original before replacing later exact duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-output-apply-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");

  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const databasePath = join(agentDir, "tool-output.sqlite");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "pi-tools.json"),
      JSON.stringify({
        version: 1,
        extensions: {
          "tool-output-compression": {
            mode: "apply",
            eligibleTools: "read",
            storage: { path: databasePath },
          },
        },
      }),
      "utf8",
    );

    const { default: extension } = await import("./index.ts");
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    let activeTools = ["read", "retrieve_tool_output"];
    const pi = {
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerCommand() {},
      getActiveTools: () => activeTools,
      setActiveTools: (tools: string[]) => {
        activeTools = tools;
      },
    };
    extension(pi as unknown as ExtensionAPI);

    const ctx = {
      cwd: root,
      isProjectTrusted: () => false,
      mode: "print",
      signal: undefined,
      sessionManager: { getSessionId: () => "session-a" },
      ui: { notify() {} },
    };
    await handlers.get("session_start")?.({}, ctx);

    const text = "x".repeat(2_000);
    const first = result("first", text);
    handlers.get("tool_execution_start")?.({ toolCallId: "first" }, ctx);
    const firstPatch = await handlers.get("tool_result")?.(first, ctx);
    assert.equal(firstPatch, undefined);
    assert.equal(first.content[0].text, text);

    const duplicate = result("duplicate", text);
    handlers.get("tool_execution_start")?.({ toolCallId: "duplicate" }, ctx);
    const duplicatePatch = await handlers.get("tool_result")?.(duplicate, ctx);
    assert.match(
      (duplicatePatch as { content: Array<{ text: string }> }).content[0].text,
      /retrieve_tool_output/,
    );
    assert.deepEqual(duplicate.details, { preserved: true });
    assert.equal(duplicate.isError, false);

    const short = "short output";
    const shortFirst = result("short-first", short);
    handlers.get("tool_execution_start")?.({ toolCallId: "short-first" }, ctx);
    assert.equal(
      await handlers.get("tool_result")?.(shortFirst, ctx),
      undefined,
    );
    const shortDuplicate = result("short-duplicate", short);
    handlers.get("tool_execution_start")?.(
      { toolCallId: "short-duplicate" },
      ctx,
    );
    // A retrieval reference would be larger, so the duplicate also passes through.
    assert.equal(
      await handlers.get("tool_result")?.(shortDuplicate, ctx),
      undefined,
    );

    const database = new Database(databasePath, { readonly: true });
    assert.equal(
      database.prepare(`SELECT COUNT(*) AS count FROM tool_outputs`).get()
        .count,
      2,
    );
    database.close();

    // Clearing in-memory references models a reload/compaction; durable lookup
    // still makes a later same-session result recoverable and compressible.
    await handlers.get("session_shutdown")?.({}, ctx);
    await handlers.get("session_start")?.({}, ctx);
    const afterReload = result("after-reload", text);
    handlers.get("tool_execution_start")?.({ toolCallId: "after-reload" }, ctx);
    const reloadPatch = await handlers.get("tool_result")?.(afterReload, ctx);
    assert.match(
      (reloadPatch as { content: Array<{ text: string }> }).content[0].text,
      /retrieve_tool_output/,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
