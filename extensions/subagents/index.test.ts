import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_FILE_NAME,
  SettingsRegistry,
} from "../../lib/pi-tools-config.ts";
import {
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
    "maxConcurrentWorkers",
    "models.task",
    "models.research",
  ]);
  assert.equal(SUBAGENT_SETTINGS.fields.enabled.default, true);
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
      extensions: { [SUBAGENTS_EXTENSION_ID]: { enabled: false } },
    });
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
  });
});
