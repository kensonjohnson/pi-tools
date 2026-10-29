import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDiagnosticTools } from "./diagnostics-registration.ts";

const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x));

test("diagnostic output enforces its byte limit after replacing short cursors with null", async () => {
  for (const sequence of [9, 99, 999, 1000]) {
    const logs = [
      { time: 2, text: "" },
      { time: 3, text: "" },
    ];
    const history = {
      captureStarted: 0,
      nextSequence: sequence,
      gaps: [],
      evictedLogs: 0,
      evictedRequests: 0,
      logs,
      requests: [],
    };
    const afterOneOmission = { ...history, omittedLogs: 1, omittedRequests: 0 };
    logs[0].text = "x".repeat(16000 - bytes(afterOneOmission));
    assert.equal(bytes(afterOneOmission), 16000);
    logs.unshift({ time: 1, text: "extra" });
    const tools = new Map<string, any>();
    registerDiagnosticTools(
      { registerTool: (tool: any) => tools.set(tool.name, tool) } as any,
      () => ({ read: () => history }) as any,
    );
    const result = await tools
      .get("browser_diagnostics")
      .execute("", { action: "read", sessionId: "s", tabId: "t" });
    const text = result.content[0].text;
    assert(
      Buffer.byteLength(text) <= 16000,
      `cursor ${sequence}: ${Buffer.byteLength(text)} bytes`,
    );
    const parsed = JSON.parse(text);
    assert.equal(parsed.nextSequence, null);
    assert(parsed.omittedLogs >= 1);
  }
});

test("exactly 16000 bytes without omissions retains the numeric cursor", async () => {
  const history = {
    captureStarted: 0,
    nextSequence: 9,
    gaps: [],
    evictedLogs: 0,
    evictedRequests: 0,
    logs: [{ time: 1, text: "" }],
    requests: [],
  };
  history.logs[0].text = "x".repeat(
    16000 - bytes({ ...history, omittedLogs: 0, omittedRequests: 0 }),
  );
  const tools = new Map<string, any>();
  registerDiagnosticTools(
    { registerTool: (tool: any) => tools.set(tool.name, tool) } as any,
    () => ({ read: () => history }) as any,
  );
  const result = await tools
    .get("browser_diagnostics")
    .execute("", { action: "read", sessionId: "s", tabId: "t" });
  assert.equal(Buffer.byteLength(result.content[0].text), 16000);
  const output = JSON.parse(result.content[0].text);
  assert.equal(output.nextSequence, 9);
  assert.equal(output.omittedLogs, 0);
});
