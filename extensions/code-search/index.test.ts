import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CODE_SEARCH_SETTINGS, CODE_SEARCH_TOOL_NAMES } from "./settings.ts";

test("trust-gates code-search settings and active tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-code-search-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");

  try {
    const { default: extension } = await import("./index.ts");
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    const tools = new Map<string, { execute: () => Promise<any> }>();
    const settingsHandlers = new Map<string, (event: unknown) => void>();
    const definitions: unknown[] = [];
    let active = ["read", "other_extension_tool"];
    const pi = {
      events: {
        emit(channel: string, data: unknown) {
          if (channel === "pi-tools:settings-definition")
            definitions.push(data);
        },
        on(channel: string, handler: (event: unknown) => void) {
          settingsHandlers.set(channel, handler);
          return () => {};
        },
      },
      on(name: string, handler: (event: unknown, ctx: any) => unknown) {
        handlers.set(name, handler);
      },
      registerTool(tool: { name: string; execute: () => Promise<any> }) {
        tools.set(tool.name, tool);
        active.push(tool.name);
      },
      getActiveTools: () => active,
      setActiveTools(toolNames: string[]) {
        active = toolNames;
      },
    };

    extension(pi as unknown as ExtensionAPI);
    settingsHandlers.get("pi-tools:settings-definition-request")?.({});
    assert.deepEqual(definitions, [CODE_SEARCH_SETTINGS]);
    assert.deepEqual(Array.from(tools.keys()), CODE_SEARCH_TOOL_NAMES);

    const cwd = join(root, "untrusted-project");
    await handlers.get("session_start")?.(
      {},
      { cwd, isProjectTrusted: () => false },
    );
    assert.deepEqual(active, ["read", "other_extension_tool"]);
    await assert.rejects(access(join(cwd, ".pi")));
    assert.equal((await tools.get("code_search")!.execute()).isError, true);

    const projectConfig = join(cwd, ".pi", "pi-tools.json");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      projectConfig,
      JSON.stringify({
        version: 1,
        extensions: { "code-search": { mode: "apply" } },
      }),
      "utf8",
    );
    await handlers.get("session_start")?.(
      {},
      { cwd, isProjectTrusted: () => true },
    );
    assert.deepEqual(active, [
      "read",
      "other_extension_tool",
      ...CODE_SEARCH_TOOL_NAMES,
    ]);

    await writeFile(
      projectConfig,
      JSON.stringify({
        version: 1,
        extensions: { "code-search": { mode: "observe" } },
      }),
      "utf8",
    );
    await handlers.get("session_start")?.(
      {},
      { cwd, isProjectTrusted: () => true },
    );
    assert.deepEqual(active, ["read", "other_extension_tool"]);

    await writeFile(
      projectConfig,
      JSON.stringify({
        version: 1,
        extensions: { "code-search": { mode: "off" } },
      }),
      "utf8",
    );
    await handlers.get("session_start")?.(
      {},
      { cwd, isProjectTrusted: () => true },
    );
    assert.deepEqual(active, ["read", "other_extension_tool"]);
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
