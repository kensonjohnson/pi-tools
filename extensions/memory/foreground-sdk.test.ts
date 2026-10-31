import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MemoryManager } from "./core.ts";
import extension from "./index.ts";
import { FOREGROUND_REVIEW_PROMPT } from "./foreground-review.ts";

test(
  "SDK command starts a visible foreground turn with normal tools",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-foreground-sdk-"));
    const cwd = join(root, "project"),
      agentDir = join(root, "agent");
    const memory = new MemoryManager(cwd, { semanticEnabled: false });
    let session:
      Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await memory.init(false, false);
      await memory.close();
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      });
      await runtime.setRuntimeApiKey("openai", "test-only");
      const model = runtime.getModel("openai", "gpt-4o");
      assert.ok(model);
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
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        model,
        modelRuntime: runtime,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
        }),
      }));
      await session.bindExtensions({});
      const events: any[] = [];
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      session.subscribe((event) => {
        events.push(event);
        if (event.type === "agent_settled") settle();
      });
      let calls = 0;
      session.agent.streamFunction = async (_model: any, context: any) => {
        calls++;
        assert.ok(
          context.messages.some(
            (m: any) =>
              m.role === "user" &&
              JSON.stringify(m.content).includes("Consolidate this project"),
          ),
        );
        const message = {
          role: "assistant",
          content:
            calls === 1
              ? [
                  {
                    type: "toolCall",
                    id: "read-1",
                    name: "read",
                    arguments: { path: ".pi/memory/knowledge.ndjson" },
                  },
                  {
                    type: "toolCall",
                    id: "write-1",
                    name: "write",
                    arguments: {
                      path: ".pi/memory/knowledge.ndjson",
                      content: "overwritten",
                    },
                  },
                  {
                    type: "toolCall",
                    id: "edit-1",
                    name: "edit",
                    arguments: {
                      path: ".pi/memory/practices.ndjson",
                      edits: [{ oldText: "old", newText: "new" }],
                    },
                  },
                  {
                    type: "toolCall",
                    id: "update-1",
                    name: "memory_update",
                    arguments: { id: "missing", content: "changed" },
                  },
                  {
                    type: "toolCall",
                    id: "forget-1",
                    name: "memory_forget",
                    arguments: { id: "missing" },
                  },
                ]
              : [{ type: "text", text: "Foreground review complete." }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: calls === 1 ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "done", reason: message.stopReason, message };
          },
          result: async () => message,
        } as any;
      };
      await session.prompt("/memory-review full");
      await settled;
      assert.equal(calls, 2);
      assert.ok(
        events.some(
          (event) =>
            event.type === "tool_execution_end" &&
            event.toolName === "read" &&
            !event.isError,
        ),
      );
      for (const name of ["write", "edit"]) {
        assert.ok(
          events.some(
            (event) =>
              event.type === "tool_execution_end" &&
              event.toolName === name &&
              event.isError &&
              JSON.stringify(event.result).includes(
                "cannot write memory files directly",
              ),
          ),
        );
      }
      assert.equal(
        await readFile(join(cwd, ".pi/memory/knowledge.ndjson"), "utf8"),
        "",
      );
      for (const name of ["memory_update", "memory_forget"]) {
        assert.ok(
          events.some(
            (event) =>
              event.type === "tool_execution_end" &&
              event.toolName === name &&
              event.isError &&
              JSON.stringify(event.result).includes("Foreground memory review"),
          ),
        );
      }
      assert.ok(
        session.messages.some(
          (message: any) =>
            message.role === "user" &&
            message.content.some(
              (part: any) =>
                part.type === "text" && part.text === FOREGROUND_REVIEW_PROMPT,
            ),
        ),
      );
      assert.equal(
        session.getLastAssistantText(),
        "Foreground review complete.",
      );
      await assert.rejects(
        access(join(cwd, ".pi/memory/.runtime/review-scheduler")),
        { code: "ENOENT" },
      );
    } finally {
      session?.dispose();
      await memory.close();
      if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  },
);
