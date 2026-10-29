import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import browserTools from "./index.ts";
import { BROWSER_TOOL_NAMES } from "./settings.ts";

test(
  "actual entry point registers and activates one toolkit on SDK session_start",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "browser-entry-sdk-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    let session:
      Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const loader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [browserTools],
      });
      await loader.reload();
      ({ session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(dir),
        settingsManager: SettingsManager.inMemory(),
        noTools: true,
      }));
      assert.equal(session.getToolDefinition("browser_session"), undefined);
      await session.bindExtensions({});
      const managed = session
        .getAllTools()
        .filter((tool) =>
          (BROWSER_TOOL_NAMES as readonly string[]).includes(tool.name),
        );
      assert.deepEqual(
        new Set(managed.map((tool) => tool.name)),
        new Set(BROWSER_TOOL_NAMES),
      );
      assert.equal(managed.length, BROWSER_TOOL_NAMES.length);
      assert.ok(
        BROWSER_TOOL_NAMES.every((name) =>
          session!.getActiveToolNames().includes(name),
        ),
      );
      assert.equal(session.getToolDefinition("browser_start"), undefined);
      await (session as any)._extensionRunner.emit({
        type: "session_shutdown",
      });
      assert.ok(
        BROWSER_TOOL_NAMES.every(
          (name) => !session!.getActiveToolNames().includes(name),
        ),
      );
      await (session as any)._extensionRunner.emit({
        type: "session_start",
        reason: "startup",
      });
      assert.ok(
        BROWSER_TOOL_NAMES.every((name) =>
          session!.getActiveToolNames().includes(name),
        ),
      );
      assert.equal(
        session
          .getAllTools()
          .filter((tool) =>
            (BROWSER_TOOL_NAMES as readonly string[]).includes(tool.name),
          ).length,
        BROWSER_TOOL_NAMES.length,
      );
      await (session as any)._extensionRunner.emit({
        type: "session_shutdown",
      });
    } finally {
      session?.dispose();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "actual entry point honors disabled global settings",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "browser-disabled-sdk-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    let session:
      Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await writeFile(
        join(dir, "pi-tools.json"),
        JSON.stringify({
          version: 1,
          extensions: { "browser-tools": { enabled: false } },
        }),
      );
      const loader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [browserTools],
      });
      await loader.reload();
      ({ session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(dir),
        settingsManager: SettingsManager.inMemory(),
        noTools: true,
      }));
      await session.bindExtensions({});
      assert.ok(
        BROWSER_TOOL_NAMES.every(
          (name) => !session!.getActiveToolNames().includes(name),
        ),
      );
      assert.equal(session.getToolDefinition("browser_session"), undefined);
      await (session as any)._extensionRunner.emit({
        type: "session_shutdown",
      });
    } finally {
      session?.dispose();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
