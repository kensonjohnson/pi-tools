import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getConfigPaths,
  getEffectiveSettings,
  SettingsRegistry,
  updateSetting,
} from "../../lib/pi-tools-config.ts";
import {
  LSP_INSPECTION_EXTENSION_ID,
  LSP_INSPECTION_SETTINGS,
  resolveLspInspectionSettings,
} from "./settings.ts";

test("LSP settings resolve default, global, and trusted-project overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-settings-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const registry = new SettingsRegistry();
  registry.register(LSP_INSPECTION_SETTINGS);

  try {
    const paths = getConfigPaths({ cwd, agentDir, configDirName: ".unused" });
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, ".unused"), { recursive: true });
    await writeFile(
      paths.global,
      JSON.stringify({
        version: 1,
        extensions: {
          [LSP_INSPECTION_EXTENSION_ID]: {
            enabled: false,
            ensureInstalled: { typescript: true },
            diagnostics: { maxCount: 50 },
          },
        },
      }),
    );
    await writeFile(
      paths.project,
      JSON.stringify({
        version: 1,
        extensions: {
          [LSP_INSPECTION_EXTENSION_ID]: {
            ensureInstalled: { python: true },
            diagnostics: { maxCount: 75 },
          },
        },
      }),
    );

    const effective = await getEffectiveSettings({
      cwd,
      agentDir,
      registry,
      projectTrusted: true,
      configDirName: ".unused",
    });
    assert.deepEqual(
      resolveLspInspectionSettings(effective.values["lsp-inspection"]),
      {
        enabled: false,
        ensureInstalled: { typescript: true, go: false, python: true },
        diagnostics: { maxCount: 75, maxBytes: 16 * 1024 },
        workspace: { maxCount: 500, maxBytes: 64 * 1024 },
      },
    );
    assert.equal(effective.sources["lsp-inspection"]?.["enabled"], "global");
    assert.equal(
      effective.sources["lsp-inspection"]?.["ensureInstalled.python"],
      "project",
    );

    const untrusted = await getEffectiveSettings({
      cwd,
      agentDir,
      registry,
      projectTrusted: false,
      configDirName: ".unused",
    });
    assert.equal(
      resolveLspInspectionSettings(untrusted.values["lsp-inspection"])
        .ensureInstalled.python,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LSP settings have fixed primitive fields and reject arbitrary server inputs", async () => {
  const fields = Object.keys(LSP_INSPECTION_SETTINGS.fields);
  assert.equal(
    fields.some((field) => /url|path|command|catalog/i.test(field)),
    false,
  );
  assert.deepEqual(LSP_INSPECTION_SETTINGS.toolNames, ["lsp_inspect"]);

  const root = await mkdtemp(join(tmpdir(), "pi-lsp-settings-input-"));
  const registry = new SettingsRegistry();
  registry.register(LSP_INSPECTION_SETTINGS);
  try {
    await assert.rejects(
      updateSetting({
        scope: "global",
        cwd: root,
        projectTrusted: true,
        extensionId: LSP_INSPECTION_EXTENSION_ID,
        field: "server.command",
        value: "unsafe",
        agentDir: join(root, "agent"),
        registry,
      }),
      /Unknown setting/,
    );
    assert.deepEqual(
      resolveLspInspectionSettings({ diagnostics: { maxCount: 0 } }),
      {
        enabled: true,
        ensureInstalled: { typescript: false, go: false, python: false },
        diagnostics: { maxCount: 100, maxBytes: 16 * 1024 },
        workspace: { maxCount: 500, maxBytes: 64 * 1024 },
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
