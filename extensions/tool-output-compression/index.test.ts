import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("registers settings and observes tool results without patching them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-output-compression-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");

  try {
    const { default: extension } = await import("./index.ts");
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    const commands = new Map<
      string,
      { handler: (args: string, ctx: any) => unknown }
    >();
    const settingsHandlers = new Map<string, (event: unknown) => void>();
    const settingsDefinitions: any[] = [];
    const pi = {
      events: {
        emit(channel: string, data: unknown) {
          if (channel === "pi-tools:settings-definition") {
            settingsDefinitions.push(data);
          }
        },
        on(channel: string, handler: (event: unknown) => void) {
          settingsHandlers.set(channel, handler);
          return () => {};
        },
      },
      on(name: string, handler: (event: unknown, ctx: any) => unknown) {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerCommand(
        name: string,
        command: { handler: (args: string, ctx: any) => unknown },
      ) {
        commands.set(name, command);
      },
    };

    extension(pi as unknown as ExtensionAPI);
    assert.ok(handlers.has("session_start"));
    assert.ok(handlers.has("tool_result"));
    assert.ok(commands.has("tool-output"));
    settingsHandlers.get("pi-tools:settings-definition-request")?.({});
    const definition = settingsDefinitions.find(
      (candidate) => candidate.id === "tool-output-compression",
    );
    assert.deepEqual(definition.fields["profiles.test.vitest.mode"], {
      type: "enum",
      default: "observe",
      values: ["off", "observe", "apply"],
      label: "Vitest profile",
      description:
        "Observe candidates without persistence; Apply stores raw output before replacing a verified result.",
    });
    assert.deepEqual(definition.fields["profiles.structured.json.mode"], {
      type: "enum",
      default: "observe",
      values: ["off", "observe", "apply"],
      label: "JSON/JSONL profile",
      description:
        "Observe candidates without persistence; Apply stores raw output before replacing a verified result.",
    });
    assert.deepEqual(definition.fields["profiles.search.records.mode"], {
      type: "enum",
      default: "observe",
      values: ["off", "observe", "apply"],
      label: "rg/grep search records profile",
      description:
        "Observe candidates without persistence; Apply stores raw output before replacing a verified result.",
    });

    const notifications: string[] = [];
    const ctx = {
      cwd: join(root, "project"),
      isProjectTrusted: () => false,
      mode: "print",
      ui: {
        notify(text: string) {
          notifications.push(text);
        },
      },
    };
    await handlers.get("session_start")?.({}, ctx);

    const event = {
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(500) }],
      isError: false,
    };
    const before = structuredClone(event);
    const patch = await handlers.get("tool_result")?.(event, ctx);
    assert.equal(patch, undefined);
    assert.deepEqual(event, before);

    const fullOutputPath = join(root, "go-verbose.txt");
    await writeFile(
      fullOutputPath,
      [
        "=== RUN   TestOne",
        "--- PASS: TestOne (0.00s)",
        "PASS",
        "ok      example/internal/one (cached)",
        "",
      ].join("\n"),
      "utf8",
    );
    const verbose = {
      toolCallId: "go-observe",
      toolName: "bash",
      content: [
        { type: "text" as const, text: "=== RUN   VisibleTail\n".repeat(100) },
      ],
      isError: false,
      details: { fullOutputPath },
    };
    const verboseBefore = structuredClone(verbose);
    assert.equal(await handlers.get("tool_result")?.(verbose, ctx), undefined);
    assert.deepEqual(verbose, verboseBefore);

    const searchObserve = {
      toolCallId: "search-observe",
      toolName: "bash",
      input: { command: "rg -n needle src" },
      content: [
        {
          type: "text" as const,
          text: "src/core.ts:7:needle\nsrc/core.ts:8:another needle\n",
        },
      ],
      isError: false,
    };
    const searchBefore = structuredClone(searchObserve);
    assert.equal(
      await handlers.get("tool_result")?.(searchObserve, ctx),
      undefined,
    );
    assert.deepEqual(searchObserve, searchBefore);

    const fullJsonPath = join(root, "json-full.txt");
    const fullJson = [
      "{",
      '  "items": [',
      ...Array.from(
        { length: 50 },
        (_, index) => `    { "index": ${index}, "message": "item ${index}" },`,
      ),
      '    { "index": 50, "message": "item 50" }',
      "  ]",
      "}",
    ].join("\n");
    await writeFile(fullJsonPath, fullJson, "utf8");
    const jsonObserve = {
      toolCallId: "json-observe",
      toolName: "bash",
      content: [
        {
          type: "text" as const,
          text: "Pi native truncated tail without JSON markers\n".repeat(30),
        },
      ],
      isError: false,
      details: { fullOutputPath: fullJsonPath },
    };
    assert.equal(
      await handlers.get("tool_result")?.(jsonObserve, ctx),
      undefined,
    );

    await commands.get("tool-output")?.handler("", ctx);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0] ?? "", /Eligible tool output/);
    assert.match(notifications[0] ?? "", /Go test \(OBSERVE\)/);
    assert.match(notifications[0] ?? "", /Go test \(OBSERVE\) · 1 candidates/);
    assert.match(notifications[0] ?? "", /Vitest \(OBSERVE\) · 0 candidates/);
    assert.match(
      notifications[0] ?? "",
      /JSON\/JSONL \(OBSERVE\) · 1 candidates/,
    );
    assert.match(
      notifications[0] ?? "",
      /rg\/grep search records \(OBSERVE\) · 1 candidates/,
    );
    const database = new Database(
      join(root, "agent", "tool-output-compression.sqlite"),
      { readonly: true },
    );
    assert.equal(
      database.prepare(`SELECT COUNT(*) AS count FROM tool_outputs`).get()
        .count,
      0,
    );
    database.close();
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
