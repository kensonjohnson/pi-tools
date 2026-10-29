import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";

class Page extends EventEmitter {
  closed = false;
  isClosed() {
    return this.closed;
  }
  url() {
    return "about:blank";
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
}
class Browser extends EventEmitter {
  page = new Page();
  async newContext() {
    return { newPage: async () => this.page };
  }
  async close() {
    await this.page.close();
    this.emit("disconnected");
  }
}

test(
  "headless SDK context cannot authorize a human handoff or self-confirm it",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "handoff-sdk-"));
    const sessions = new ManagedSessions({
      launch: async () => new Browser() as never,
    });
    let tool: any, context: any;
    let agent:
      Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const loader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          (pi) => {
            const register = pi.registerTool.bind(pi);
            pi.registerTool = ((definition: any) => {
              if (definition.name === "browser_handoff") tool = definition;
              return register(definition);
            }) as typeof pi.registerTool;
            createManagedBrowserExtension(pi, {
              loadSettings: async () => ({ values: {} }) as never,
              createSessions: () => sessions,
            });
            pi.on("session_start", async (_event, ctx) => {
              context = ctx;
            });
          },
        ],
      });
      await loader.reload();
      ({ session: agent } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(dir),
        settingsManager: SettingsManager.inMemory(),
        noTools: true,
      }));
      await agent.bindExtensions({});
      assert.ok(context);
      assert.equal(context.hasUI, false);
      const owner = context.sessionManager.getSessionId();
      const target = await sessions.start({
        artifactOwner: owner,
        headless: false,
      });
      const result = await tool.execute(
        "id",
        { action: "pause", ...target },
        undefined,
        undefined,
        context,
      );
      assert.equal(JSON.parse(result.content[0].text).status, "unsupported");
      const handoff = await sessions.beginHandoff(target, owner);
      assert.equal(handoff.status, "awaiting_human");
      await (agent as any)._extensionRunner.emitInput(
        `browser-resume ${target.sessionId} ${handoff.handoffId}`,
        undefined,
        "extension",
      );
      assert.equal(
        sessions.handoffStatus(target.sessionId, owner).status,
        "awaiting_human",
      );
    } finally {
      agent?.dispose();
      await sessions.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
