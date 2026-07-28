import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CONFIG_FILE_NAME,
  SettingsRegistry,
  getConfigPaths,
  getEffectiveSettings,
  parseSettingInput,
  publishExtensionSettings,
  SETTINGS_DEFINITION_EVENT,
  SETTINGS_DEFINITION_REQUEST_EVENT,
  getSettingValue,
  updateSetting,
} from "./pi-tools-config.ts";

function createRegistry(): SettingsRegistry {
  const registry = new SettingsRegistry();
  registry.register({
    id: "alpha",
    label: "Alpha",
    fields: {
      enabled: { type: "boolean", default: true },
      mode: { type: "enum", default: "safe", values: ["safe", "fast"] },
      "quota.refreshMinutes": {
        type: "number",
        default: 5,
        minimum: 1,
        maximum: 60,
      },
      label: { type: "string", default: "default" },
    },
    toolNames: ["alpha_tool"],
  });
  return registry;
}

async function withTemporaryPaths(
  run: (paths: { cwd: string; agentDir: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-config-"));
  try {
    await run({ cwd: join(root, "project"), agentDir: join(root, "agent") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("uses defaults then applies global and trusted project overrides", async () => {
  await withTemporaryPaths(async ({ cwd, agentDir }) => {
    const registry = createRegistry();
    const paths = getConfigPaths({ cwd, agentDir });
    await writeJson(paths.global, {
      version: 1,
      extensions: {
        alpha: { enabled: false, quota: { refreshMinutes: 10 } },
      },
    });
    await writeJson(paths.project, {
      version: 1,
      extensions: {
        alpha: { mode: "fast", quota: { refreshMinutes: 15 } },
      },
    });

    const settings = await getEffectiveSettings({
      cwd,
      agentDir,
      projectTrusted: true,
      registry,
    });

    assert.equal(getSettingValue(settings, "alpha", "enabled"), false);
    assert.equal(getSettingValue(settings, "alpha", "mode"), "fast");
    assert.equal(
      getSettingValue(settings, "alpha", "quota.refreshMinutes"),
      15,
    );
    assert.equal(getSettingValue(settings, "alpha", "label"), "default");
    assert.deepEqual(settings.sources.alpha, {
      enabled: "global",
      mode: "project",
      "quota.refreshMinutes": "project",
      label: "default",
    });
  });
});

test("does not read a project override before project trust", async () => {
  await withTemporaryPaths(async ({ cwd, agentDir }) => {
    const registry = createRegistry();
    const paths = getConfigPaths({ cwd, agentDir });
    await writeJson(paths.global, {
      version: 1,
      extensions: { alpha: { enabled: false } },
    });
    await writeJson(paths.project, {
      version: 1,
      extensions: { alpha: { enabled: true, mode: "fast" } },
    });

    const settings = await getEffectiveSettings({
      cwd,
      agentDir,
      projectTrusted: false,
      registry,
    });

    assert.equal(getSettingValue(settings, "alpha", "enabled"), false);
    assert.equal(getSettingValue(settings, "alpha", "mode"), "safe");
    assert.equal(settings.diagnostics.length, 0);
  });
});

test("ignores malformed documents and invalid field values", async () => {
  await withTemporaryPaths(async ({ cwd, agentDir }) => {
    const registry = createRegistry();
    const paths = getConfigPaths({ cwd, agentDir });
    await writeJson(paths.global, {
      version: 1,
      extensions: {
        alpha: { enabled: "no", mode: "invalid", quota: { refreshMinutes: 0 } },
      },
    });
    await writeFile(paths.project, "not json", "utf8").catch(async () => {
      await writeJson(paths.project, "not json");
    });

    const settings = await getEffectiveSettings({
      cwd,
      agentDir,
      projectTrusted: true,
      registry,
    });

    assert.equal(getSettingValue(settings, "alpha", "enabled"), true);
    assert.equal(getSettingValue(settings, "alpha", "mode"), "safe");
    assert.equal(getSettingValue(settings, "alpha", "quota.refreshMinutes"), 5);
    assert.equal(settings.diagnostics.length, 4);
  });
});

test("writes a scoped update atomically without clobbering sibling settings", async () => {
  await withTemporaryPaths(async ({ cwd, agentDir }) => {
    const registry = createRegistry();
    const paths = getConfigPaths({ cwd, agentDir });
    await writeJson(paths.global, {
      version: 1,
      extensions: {
        alpha: { mode: "fast" },
        unknown: { retained: true },
      },
    });

    await Promise.all([
      updateSetting({
        scope: "global",
        cwd,
        agentDir,
        projectTrusted: false,
        extensionId: "alpha",
        field: "enabled",
        value: false,
        registry,
      }),
      updateSetting({
        scope: "global",
        cwd,
        agentDir,
        projectTrusted: false,
        extensionId: "alpha",
        field: "quota.refreshMinutes",
        value: 30,
        registry,
      }),
    ]);

    const document = JSON.parse(await readFile(paths.global, "utf8"));
    assert.deepEqual(document, {
      version: 1,
      extensions: {
        alpha: {
          mode: "fast",
          enabled: false,
          quota: { refreshMinutes: 30 },
        },
        unknown: { retained: true },
      },
    });
    assert.equal((await stat(paths.global)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await readdir(agentDir)).filter((entry) => entry.includes(".tmp")),
      [],
    );
  });
});

test("publishes extension definitions over Pi's shared event bus", () => {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const events = {
    emit(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      const listeners = handlers.get(channel) ?? [];
      listeners.push(handler);
      handlers.set(channel, listeners);
      return () =>
        handlers.set(
          channel,
          listeners.filter((entry) => entry !== handler),
        );
    },
  };
  const definition = {
    id: "published-settings",
    label: "Published Settings",
    fields: { enabled: { type: "boolean" as const, default: true } },
  };
  let received: unknown;
  events.on(SETTINGS_DEFINITION_EVENT, (value) => {
    received = value;
  });
  publishExtensionSettings(events, definition);
  events.emit(SETTINGS_DEFINITION_REQUEST_EVENT, undefined);

  assert.deepEqual(received, definition);
});

test("uses the latest event definition after an extension reload", () => {
  const registry = new SettingsRegistry();
  registry.register({
    id: "reloaded-extension",
    label: "Old label",
    fields: { enabled: { type: "boolean", default: true } },
  });
  registry.replace({
    id: "reloaded-extension",
    label: "New label",
    fields: { enabled: { type: "boolean", default: true } },
  });

  assert.equal(registry.get("reloaded-extension")?.label, "New label");
});

test("allows identical settings registration during extension reload", () => {
  const registry = createRegistry();
  const definition = registry.get("alpha")!;
  registry.register({
    ...definition,
    fields: { ...definition.fields },
    toolNames: definition.toolNames ? [...definition.toolNames] : undefined,
  });
  assert.equal(registry.list().length, 1);
});

test("parses scalar input according to registered field definitions", () => {
  const fields = createRegistry().get("alpha")!.fields;
  assert.equal(parseSettingInput(fields.enabled, "enabled"), true);
  assert.equal(parseSettingInput(fields.enabled, "off"), false);
  assert.equal(parseSettingInput(fields.enabled, "maybe"), undefined);
  assert.equal(parseSettingInput(fields["quota.refreshMinutes"], "30"), 30);
  assert.equal(
    parseSettingInput(fields["quota.refreshMinutes"], "0"),
    undefined,
  );
  assert.equal(parseSettingInput(fields.mode, "fast"), "fast");
  assert.equal(parseSettingInput(fields.mode, "unsafe"), undefined);
  assert.equal(parseSettingInput(fields.label, "weekly quota"), "weekly quota");
});

test("requires trust for project writes and writes a sparse project override", async () => {
  await withTemporaryPaths(async ({ cwd, agentDir }) => {
    const registry = createRegistry();
    const paths = getConfigPaths({ cwd, agentDir });

    await assert.rejects(
      updateSetting({
        scope: "project",
        cwd,
        agentDir,
        projectTrusted: false,
        extensionId: "alpha",
        field: "mode",
        value: "fast",
        registry,
      }),
      /trusted/,
    );

    await updateSetting({
      scope: "project",
      cwd,
      agentDir,
      projectTrusted: true,
      extensionId: "alpha",
      field: "mode",
      value: "fast",
      registry,
    });

    assert.equal(paths.project.endsWith(join(".pi", CONFIG_FILE_NAME)), true);
    assert.deepEqual(JSON.parse(await readFile(paths.project, "utf8")), {
      version: 1,
      extensions: { alpha: { mode: "fast" } },
    });
  });
});
