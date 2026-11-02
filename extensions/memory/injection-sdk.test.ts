import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

test(
  "real SDK sessions never inject memory messages across compaction and shutdown",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-memory-injection-sdk-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const sessions: Awaited<
      ReturnType<typeof createAgentSession>
    >["session"][] = [];
    const errors: unknown[] = [];
    const knowledgeFile = join(cwd, ".pi", "memory", "knowledge.ndjson");
    async function writeKnowledge(content: string) {
      await writeFile(
        knowledgeFile,
        `${JSON.stringify({ id: "one", content, created: "2026-01-01" })}\n`,
      );
    }
    try {
      await mkdir(join(cwd, ".pi", "memory"), { recursive: true });
      await writeKnowledge("Original SDK fact");
      for (let i = 0; i < 2; i++) {
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          extensionFactories: [extension],
        });
        await loader.reload();
        const { session } = await createAgentSession({
          cwd,
          agentDir,
          resourceLoader: loader,
          sessionManager: SessionManager.inMemory(cwd, {
            id: "same-session-id",
          }),
          settingsManager: SettingsManager.inMemory(),
          noTools: true,
        });
        sessions.push(session);
        await session.bindExtensions({});
        session.extensionRunner.onError((error) => errors.push(error));
      }
      const [first, second] = sessions;
      assert.equal(
        first.sessionManager.getSessionId(),
        second.sessionManager.getSessionId(),
      );
      async function start(session: typeof first) {
        return session.extensionRunner.emitBeforeAgentStart(
          "test",
          undefined,
          "system",
          { cwd },
        );
      }
      async function compact(session: typeof first) {
        await session.extensionRunner.emit({
          type: "session_compact",
          reason: "manual",
          fromExtension: false,
          willRetry: false,
          compactionEntry: {
            type: "compaction",
            id: "compact",
            parentId: null,
            timestamp: new Date().toISOString(),
            summary: "summary",
            firstKeptEntryId: "kept",
            tokensBefore: 1,
          },
        });
      }
      assert.equal(await start(first), undefined);
      assert.equal(await start(second), undefined);
      await writeKnowledge("Updated SDK fact");
      assert.equal(await start(first), undefined);
      assert.equal(await start(second), undefined);
      await compact(first);
      assert.equal(await start(first), undefined);
      assert.equal(await start(second), undefined);
      await first.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      first.dispose();
      await compact(second);
      assert.equal(await start(second), undefined);
      assert.equal(await start(second), undefined);
      await second.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      assert.deepEqual(errors, []);
    } finally {
      for (const session of sessions) session.dispose();
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  },
);
