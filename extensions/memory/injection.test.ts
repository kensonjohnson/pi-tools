import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

function session(cwd: string, id: string, trusted = true) {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const tools = new Set<string>();
  const pi = {
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
      handlers.set(name, handler);
    },
    registerTool(tool: { name: string }) {
      tools.add(tool.name);
    },
    getActiveTools: () => ["memory_remember", "memory_recall", "other"],
    setActiveTools() {},
  };
  extension(pi as unknown as ExtensionAPI);
  const ctx = {
    cwd,
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => id },
  };
  return {
    tools,
    async emit(name: string) {
      return handlers.get(name)?.(
        { prompt: "test", systemPrompt: "system" },
        ctx,
      );
    },
  };
}

async function knowledge(root: string, content: string) {
  const dir = join(root, ".pi", "memory");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "knowledge.ndjson"),
    content
      ? `${JSON.stringify({ id: "id", created: "2026-01-01", content })}\n`
      : "",
  );
}

async function config(dir: string, enabled: boolean) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "pi-tools.json"),
    JSON.stringify({ version: 1, extensions: { memory: { enabled } } }),
  );
}

test("sessions never inject memory messages, including after compaction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-injection-"));
  const project = join(root, "project");
  const agent = join(root, "agent");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  await knowledge(project, "Original fact");
  const first = session(project, "same-id");
  const second = session(project, "same-id");
  assert.ok(first.tools.has("memory_recall"));
  assert.equal(await first.emit("before_agent_start"), undefined);
  assert.equal(await second.emit("before_agent_start"), undefined);
  await knowledge(project, "Updated fact");
  assert.equal(await first.emit("before_agent_start"), undefined);
  await first.emit("session_compact");
  assert.equal(await first.emit("before_agent_start"), undefined);
  assert.equal(await second.emit("before_agent_start"), undefined);
  await first.emit("session_shutdown");
  await second.emit("session_compact");
  assert.equal(await second.emit("before_agent_start"), undefined);
  await second.emit("session_shutdown");

  await knowledge(project, "");
  const empty = session(project, "empty");
  assert.equal(await empty.emit("before_agent_start"), undefined);
  await knowledge(project, "New fact");
  assert.equal(await empty.emit("before_agent_start"), undefined);
  await empty.emit("session_compact");
  assert.equal(await empty.emit("before_agent_start"), undefined);
  await empty.emit("session_shutdown");

  // Neither trusted nor ignored settings should enable automatic injection.
  for (const [globalEnabled, projectEnabled] of [
    [false, true],
    [true, false],
  ]) {
    await config(agent, globalEnabled);
    await config(join(project, ".pi"), projectEnabled);
    for (const trusted of [true, false]) {
      const current = session(project, `config-${trusted}`, trusted);
      assert.equal(await current.emit("before_agent_start"), undefined);
      await current.emit("session_compact");
      assert.equal(await current.emit("before_agent_start"), undefined);
      await current.emit("session_shutdown");
    }
  }
});
