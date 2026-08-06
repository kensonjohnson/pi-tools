import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CompletionInbox } from "./completion-inbox.ts";
import {
  CONFIG_FILE_NAME,
  SettingsRegistry,
} from "../../lib/pi-tools-config.ts";
import {
  resolveSubagentDelegationMode,
  resolveSubagentLaunchPolicy,
  resolveSubagentModel,
} from "./launch-policy.ts";
import {
  SUBAGENTS_EXTENSION_ID,
  SUBAGENT_SETTINGS,
  SUBAGENT_TOOL_NAMES,
} from "./settings.ts";

const parentModel = {
  provider: "parent",
  id: "parent-model",
  name: "Parent model",
};
const configuredModel = {
  provider: "worker",
  id: "worker-model",
  name: "Worker model",
};

function modelContext(overrides: Record<string, unknown> = {}) {
  return {
    model: parentModel,
    thinkingLevel: "high",
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => [parentModel, configuredModel],
    },
    ...overrides,
  } as any;
}

async function withTemporaryConfig(
  run: (paths: { cwd: string; agentDir: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-subagents-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await run({ cwd: join(root, "project"), agentDir });
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

test("registers the approved four Subagents settings", () => {
  assert.deepEqual(Object.keys(SUBAGENT_SETTINGS.fields), [
    "enabled",
    "delegationMode",
    "maxConcurrentWorkers",
    "models.task",
    "models.research",
  ]);
  assert.equal(SUBAGENT_SETTINGS.fields.enabled.default, true);
  assert.equal(SUBAGENT_SETTINGS.fields.delegationMode.default, "proactive");
  assert.equal(SUBAGENT_SETTINGS.fields.maxConcurrentWorkers.default, 2);
  assert.equal(SUBAGENT_SETTINGS.fields["models.task"].default, "inherit");
  assert.equal(SUBAGENT_SETTINGS.fields["models.research"].default, "inherit");
});

test("inherits the parent model or resolves an available configured worker model", () => {
  const ctx = modelContext();
  const inherited = resolveSubagentModel(ctx, "task", "inherit");
  assert.equal(inherited.model, parentModel);
  assert.equal(inherited.thinkingLevel, "high");
  assert.equal(inherited.source, "inherit");

  const configured = resolveSubagentModel(
    ctx,
    "research",
    "worker/worker-model",
  );
  assert.equal(configured.model, configuredModel);
  assert.equal(configured.source, "configured");
  assert.equal(
    resolveSubagentModel(ctx, "task", "worker/worker-model:high").thinkingLevel,
    "high",
  );
  assert.throws(
    () => resolveSubagentModel(ctx, "task", "missing/model"),
    /Configured task worker model 'missing\/model' is unavailable/,
  );
});

test("uses trusted project overrides and rejects disabled or untrusted launches", async () => {
  await withTemporaryConfig(async ({ cwd, agentDir }) => {
    const registry = new SettingsRegistry();
    registry.register(SUBAGENT_SETTINGS);
    await writeJson(join(agentDir, CONFIG_FILE_NAME), {
      version: 1,
      extensions: {
        [SUBAGENTS_EXTENSION_ID]: {
          maxConcurrentWorkers: 1,
          models: { task: "worker/worker-model" },
        },
      },
    });
    await writeJson(join(cwd, ".pi", CONFIG_FILE_NAME), {
      version: 1,
      extensions: {
        [SUBAGENTS_EXTENSION_ID]: {
          maxConcurrentWorkers: 2,
          models: { task: "inherit" },
        },
      },
    });

    const trusted = {
      ...modelContext(),
      cwd,
      isProjectTrusted: () => true,
    };
    const policy = await resolveSubagentLaunchPolicy(trusted, "task", {
      registry,
    });
    assert.equal(
      await resolveSubagentDelegationMode(trusted, { registry }),
      "proactive",
    );
    assert.equal(policy.maxConcurrentWorkers, 2);
    assert.equal(policy.model.model, parentModel);

    await assert.rejects(
      resolveSubagentLaunchPolicy(
        { ...trusted, isProjectTrusted: () => false },
        "task",
        { registry },
      ),
      /trusted project/,
    );

    await writeJson(join(agentDir, CONFIG_FILE_NAME), {
      version: 1,
      extensions: { [SUBAGENTS_EXTENSION_ID]: { delegationMode: "manual" } },
    });
    assert.equal(
      await resolveSubagentDelegationMode(trusted, { registry }),
      "manual",
    );
    await writeJson(join(agentDir, CONFIG_FILE_NAME), {
      version: 1,
      extensions: { [SUBAGENTS_EXTENSION_ID]: { enabled: false } },
    });
    assert.equal(
      await resolveSubagentDelegationMode(
        { ...trusted, cwd: join(agentDir, "other-project") },
        { registry },
      ),
      "manual",
    );
    await assert.rejects(
      resolveSubagentLaunchPolicy(
        { ...trusted, cwd: join(agentDir, "other-project") },
        "research",
        { registry },
      ),
      /disabled/,
    );
  });
});

test("queues durable completion inbox records only after settlement and acknowledges matching messages", async () => {
  await withTemporaryConfig(async ({ cwd, agentDir }) => {
    await writeJson(join(agentDir, CONFIG_FILE_NAME), {
      version: 1,
      extensions: {
        [SUBAGENTS_EXTENSION_ID]: { enabled: true, delegationMode: "manual" },
      },
    });
    const { default: extension } = await import("./index.ts");
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const sent: Array<{ message: any; options: any }> = [];
    const pi = {
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerEntryRenderer() {},
      getActiveTools: () => SUBAGENT_TOOL_NAMES,
      setActiveTools() {},
      sendMessage(message: any, options: any) {
        sent.push({ message, options });
      },
      appendEntry() {},
    };
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      ui: { setWidget() {} },
    };
    extension(pi as unknown as ExtensionAPI);
    await handlers.get("session_start")?.({}, ctx);

    const inbox = new CompletionInbox(join(cwd, "tmp", "subagents"));
    await inbox.create({
      workstreamId: "settled-worker",
      kind: "task",
      terminalStatus: "settled",
      handoff: "Task worker settled without interrupting the parent.",
      artifactReferences: ["tmp/subagents/settled-worker/reports/0001.json"],
      sourceCustomType: "pi-tools:subagent-task-handoff",
      sourceDetails: { workstreamId: "settled-worker" },
    });
    assert.equal(sent.length, 0);

    await handlers.get("agent_settled")?.({}, ctx);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.options, { deliverAs: "nextTurn" });
    assert.equal((await inbox.list())[0]?.deliveryState, "scheduled");

    await handlers.get("message_end")?.(
      {
        message: { ...sent[0]?.message, role: "custom", timestamp: Date.now() },
      },
      ctx,
    );
    assert.equal((await inbox.list())[0]?.deliveryState, "acknowledged");
    await handlers.get("session_shutdown")?.({}, ctx);
  });
});

test("interrupts an active main-session wait and replays captured user inputs FIFO", async () => {
  await withTemporaryConfig(async ({ cwd, agentDir }) => {
    await writeJson(join(agentDir, CONFIG_FILE_NAME), {
      version: 1,
      extensions: {
        [SUBAGENTS_EXTENSION_ID]: { enabled: true, delegationMode: "manual" },
      },
    });
    const { default: extension } = await import("./index.ts");
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const replayed: unknown[] = [];
    const pi = {
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(name, handler);
      },
      registerTool() {},
      registerEntryRenderer() {},
      getActiveTools: () => SUBAGENT_TOOL_NAMES,
      setActiveTools() {},
      sendMessage() {},
      sendUserMessage(content: unknown) {
        replayed.push(content);
      },
      appendEntry() {},
    };
    let idle = false;
    let aborts = 0;
    const ctx = {
      cwd,
      isProjectTrusted: () => true,
      isIdle: () => idle,
      abort() {
        aborts++;
      },
      ui: { setWidget() {} },
    };
    extension(pi as unknown as ExtensionAPI);
    await handlers.get("session_start")?.({}, ctx);

    handlers.get("tool_execution_start")?.(
      { toolCallId: "wait-1", toolName: "subagent_wait", args: {} },
      ctx,
    );
    const image = { type: "image", data: "preserved", mimeType: "image/png" };
    assert.deepEqual(
      await handlers.get("input")?.(
        {
          text: "First user message",
          images: [image],
          source: "interactive",
          streamingBehavior: "steer",
        },
        ctx,
      ),
      { action: "handled" },
    );
    assert.deepEqual(
      await handlers.get("input")?.(
        {
          text: "Second user message",
          source: "rpc",
          streamingBehavior: "followUp",
        },
        ctx,
      ),
      { action: "handled" },
    );
    assert.equal(aborts, 2);

    assert.equal(
      await handlers.get("input")?.(
        {
          text: "Extension replay must not recurse",
          source: "extension",
          streamingBehavior: "steer",
        },
        ctx,
      ),
      undefined,
    );
    const workerCtx = {
      ...ctx,
      sessionManager: {
        getSessionDir: () => join(cwd, "tmp", "subagents", "worker", "session"),
      },
    };
    assert.equal(
      await handlers.get("input")?.(
        {
          text: "SDK worker input must not interrupt",
          source: "interactive",
          streamingBehavior: "steer",
        },
        workerCtx,
      ),
      undefined,
    );
    assert.equal(aborts, 2);

    handlers.get("tool_execution_end")?.(
      {
        toolCallId: "wait-1",
        toolName: "subagent_wait",
        result: {},
        isError: true,
      },
      ctx,
    );
    assert.deepEqual(
      await handlers.get("input")?.(
        {
          text: "Third user message after the wait tool ended",
          source: "interactive",
          streamingBehavior: "steer",
        },
        ctx,
      ),
      { action: "handled" },
    );
    assert.equal(aborts, 3);

    idle = true;
    await handlers.get("agent_settled")?.({}, ctx);
    assert.deepEqual(replayed, [
      [{ type: "text", text: "First user message" }, image],
    ]);
    await handlers.get("agent_settled")?.({}, ctx);
    assert.deepEqual(replayed, [
      [{ type: "text", text: "First user message" }, image],
      "Second user message",
    ]);
    await handlers.get("agent_settled")?.({}, ctx);
    assert.deepEqual(replayed, [
      [{ type: "text", text: "First user message" }, image],
      "Second user message",
      "Third user message after the wait tool ended",
    ]);

    idle = false;
    handlers.get("tool_execution_start")?.(
      { toolCallId: "wait-2", toolName: "subagent_wait", args: {} },
      ctx,
    );
    await handlers.get("input")?.(
      {
        text: "Do not replay after shutdown",
        source: "interactive",
        streamingBehavior: "steer",
      },
      ctx,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
    idle = true;
    await handlers.get("agent_settled")?.({}, ctx);
    assert.equal(replayed.length, 3);
  });
});

test("removes future launch and control tools when disabled", async () => {
  await withTemporaryConfig(async ({ cwd, agentDir }) => {
    await writeJson(join(agentDir, CONFIG_FILE_NAME), {
      version: 1,
      extensions: { [SUBAGENTS_EXTENSION_ID]: { enabled: false } },
    });

    const { default: extension } = await import("./index.ts");
    const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
    const eventHandlers = new Map<string, (value: unknown) => void>();
    const definitions: unknown[] = [];
    const registeredTools: unknown[] = [];
    const entryRenderers: unknown[] = [];
    let active = ["read", ...SUBAGENT_TOOL_NAMES];
    const pi = {
      events: {
        emit(channel: string, value: unknown) {
          if (channel === "pi-tools:settings-definition")
            definitions.push(value);
        },
        on(channel: string, handler: (value: unknown) => void) {
          eventHandlers.set(channel, handler);
          return () => eventHandlers.delete(channel);
        },
      },
      on(name: string, handler: (event: unknown, ctx: any) => unknown) {
        handlers.set(name, handler);
      },
      registerTool(tool: unknown) {
        registeredTools.push(tool);
      },
      registerEntryRenderer(type: string, renderer: unknown) {
        entryRenderers.push({ type, renderer });
      },
      getActiveTools: () => active,
      setActiveTools(toolNames: string[]) {
        active = toolNames;
      },
    };
    extension(pi as unknown as ExtensionAPI);
    eventHandlers.get("pi-tools:settings-definition-request")?.(undefined);
    await handlers.get("session_start")?.(
      {},
      { cwd, isProjectTrusted: () => true },
    );
    assert.deepEqual(active, ["read"]);
    assert.deepEqual(definitions, [SUBAGENT_SETTINGS]);
    assert.equal(registeredTools.length, 8);
    assert.deepEqual(
      entryRenderers.map((entry: any) => entry.type),
      [
        "pi-tools:subagent-task-timeline",
        "pi-tools:subagent-task-control-timeline",
        "pi-tools:subagent-research-timeline",
      ],
    );
  });
});
