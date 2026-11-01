import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";

function session(cwd: string, id: string, trusted = true) {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
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
    registerTool() {},
    getActiveTools: () => ["memory_remember", "other"],
    setActiveTools() {},
  };
  extension(pi as unknown as ExtensionAPI);
  const ctx = {
    cwd,
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => id },
  };
  return {
    async emit(name: string) {
      const handler = handlers.get(name);
      assert.ok(handler, `missing ${name} handler`);
      return handler({}, ctx);
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

function message(result: any): string | undefined {
  if (!result) return undefined;
  assert.equal(result.message.customType, "project_memory");
  assert.equal(result.message.display, false);
  return result.message.content;
}

test("knowledge injection follows independent session lifecycles and config precedence", async (t) => {
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
  assert.match(
    message(await first.emit("before_agent_start"))!,
    /Original fact/,
  );
  assert.match(
    message(await second.emit("before_agent_start"))!,
    /Original fact/,
  );
  assert.equal(await first.emit("before_agent_start"), undefined);
  assert.equal(await second.emit("before_agent_start"), undefined);

  await knowledge(project, "Updated fact");
  assert.equal(await first.emit("before_agent_start"), undefined);
  assert.equal(await second.emit("before_agent_start"), undefined);
  await first.emit("session_compact");
  const refreshed = message(await first.emit("before_agent_start"))!;
  assert.match(refreshed, /Updated fact/);
  assert.doesNotMatch(refreshed, /Original fact/);
  assert.equal(await second.emit("before_agent_start"), undefined);
  await first.emit("session_shutdown");
  await second.emit("session_compact");
  assert.match(
    message(await second.emit("before_agent_start"))!,
    /Updated fact/,
  );
  await second.emit("session_shutdown");

  // An initially empty briefing stays unchanged until compaction.
  await knowledge(project, "");
  const empty = session(project, "empty");
  assert.equal(await empty.emit("before_agent_start"), undefined);
  await knowledge(project, "New fact");
  assert.equal(await empty.emit("before_agent_start"), undefined);
  await empty.emit("session_compact");
  assert.match(message(await empty.emit("before_agent_start"))!, /New fact/);
  await empty.emit("session_shutdown");

  // Trusted project settings override global settings; untrusted settings do not.
  await config(agent, false);
  await config(join(project, ".pi"), true);
  const untrusted = session(project, "untrusted", false);
  assert.equal(await untrusted.emit("before_agent_start"), undefined);
  const trusted = session(project, "trusted", true);
  assert.match(message(await trusted.emit("before_agent_start"))!, /New fact/);
  await trusted.emit("session_shutdown");
  await untrusted.emit("session_shutdown");
  await config(agent, true);
  await config(join(project, ".pi"), false);
  const disabled = session(project, "disabled", true);
  assert.equal(await disabled.emit("before_agent_start"), undefined);
  const ignoredDisable = session(project, "ignored-disable", false);
  assert.match(
    message(await ignoredDisable.emit("before_agent_start"))!,
    /New fact/,
  );
  await disabled.emit("session_shutdown");
  await ignoredDisable.emit("session_shutdown");
});
