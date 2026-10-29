import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserDiagnostics } from "./diagnostics.ts";
import {
  registerDiagnosticTools,
  DIAGNOSTIC_TOOL_NAMES,
} from "./diagnostics-registration.ts";

test("staged registration resolves current collector and emits bounded results", async () => {
  const tools = new Map<string, any>();
  const d = new BrowserDiagnostics();
  registerDiagnosticTools(
    { registerTool: (tool: any) => tools.set(tool.name, tool) } as any,
    () => d,
  );
  assert.deepEqual([...tools.keys()], [...DIAGNOSTIC_TOOL_NAMES]);
  const page = new EventEmitter();
  const target = { sessionId: "s", tabId: "t" };
  d.attach(target, page as any);
  for (let i = 0; i < 100; i++)
    page.emit("console", {
      location: () => ({}),
      type: () => "log",
      text: () => "x".repeat(2000),
    });
  const response = await tools
    .get("browser_diagnostics")
    .execute("", { ...target, action: "read" });
  assert(Buffer.byteLength(response.content[0].text) <= 16000);
  const output = JSON.parse(response.content[0].text);
  assert(output.omittedLogs > 0);
  assert.equal(output.nextSequence, null);
  await tools
    .get("browser_diagnostics")
    .execute("", { ...target, action: "clear" });
  assert.equal(d.read(target).logs.length, 0);
  const empty = JSON.parse(
    (
      await tools
        .get("browser_diagnostics")
        .execute("", { ...target, action: "read" })
    ).content[0].text,
  );
  page.emit("console", {
    location: () => ({}),
    type: () => "log",
    text: () => "new",
  });
  const incremental = JSON.parse(
    (
      await tools.get("browser_diagnostics").execute("", {
        ...target,
        action: "read",
        afterSequence: empty.nextSequence,
      })
    ).content[0].text,
  );
  assert.equal(incremental.logs[0].text, "new");
  d.shutdown();
});
