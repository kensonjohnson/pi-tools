import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RETRIEVE_TOOL_OUTPUT_NAME, registerRetrieveTool } from "./retrieve.ts";
import { ToolOutputStore } from "./store.ts";

test("retrieval tool returns bounded session-scoped original output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-output-retrieve-"));
  try {
    const store = new ToolOutputStore({
      path: join(root, "tool-output.sqlite"),
      maxBytes: 10_000,
      retentionDays: 30,
      maxOutputBytes: 5_000,
      retrievalMaxBytes: 1_024,
    });
    await store.store({
      id: "stored-output",
      sessionId: "session-a",
      toolCallId: "call-a",
      toolName: "read",
      contentHash: "hash-a",
      content: "original text",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 10_000,
    });

    let tool: any;
    registerRetrieveTool(
      {
        registerTool(definition: unknown) {
          tool = definition;
        },
      } as ExtensionAPI,
      () => store,
    );
    assert.equal(tool.name, RETRIEVE_TOOL_OUTPUT_NAME);

    const context = { sessionManager: { getSessionId: () => "session-a" } };
    const found = await tool.execute(
      "retrieve-call",
      { id: "stored-output", maxBytes: 1_024 },
      undefined,
      undefined,
      context,
    );
    assert.match(found.content[0].text, /Stored tool output: read/);
    assert.match(found.content[0].text, /original text/);
    assert.equal(found.details.found, true);

    const missing = await tool.execute(
      "retrieve-call",
      { id: "stored-output" },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "session-b" } },
    );
    assert.match(missing.content[0].text, /No available stored tool output/);
    assert.equal(missing.details.found, false);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
