import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SettingsRegistry,
  getConfigPaths,
  getEffectiveSettings,
} from "../../lib/pi-tools-config.ts";
import {
  BROWSER_SETTINGS,
  BROWSER_SETTINGS_ID,
  resolveBrowserSettings,
} from "./settings.ts";

test("download and artifact limits accept caller configuration beyond one GiB", () => {
  const settings = resolveBrowserSettings({
    artifactQuotaBytes: 5 * 1024 ** 3,
    downloadMaxFileBytes: 2 * 1024 ** 3,
    downloadMaxActive: 7,
  });
  assert.equal(settings.artifactQuotaBytes, 5 * 1024 ** 3);
  assert.equal(settings.downloadMaxFileBytes, 2 * 1024 ** 3);
  assert.equal(settings.downloadMaxActive, 7);
});

test("browser settings apply defaults, global settings and trusted project overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-settings-"));
  try {
    const cwd = join(root, "project"),
      agentDir = join(root, "agent");
    const paths = getConfigPaths({ cwd, agentDir });
    const write = async (path: string, value: unknown) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(value));
    };
    await write(paths.global, {
      version: 1,
      extensions: {
        [BROWSER_SETTINGS_ID]: {
          autoInstall: false,
          navigationTimeoutMs: 12000,
        },
      },
    });
    await write(paths.project, {
      version: 1,
      extensions: {
        [BROWSER_SETTINGS_ID]: {
          enabled: false,
          autoInstall: true,
          navigationTimeoutMs: 22000,
        },
      },
    });
    const registry = new SettingsRegistry();
    registry.register(BROWSER_SETTINGS);
    const get = async (projectTrusted: boolean) =>
      resolveBrowserSettings(
        (
          await getEffectiveSettings({
            cwd,
            agentDir,
            projectTrusted,
            registry,
          })
        ).values[BROWSER_SETTINGS_ID],
      );
    assert.deepEqual(await get(false), {
      enabled: true,
      autoInstall: false,
      diagnosticsEnabled: true,
      diagnosticsMaxEntries: 500,
      diagnosticsMaxBytes: 1048576,
      navigationTimeoutMs: 12000,
      profileWaitTimeoutMs: 30000,
      startupTimeoutMs: 180000,
      shutdownTimeoutMs: 5000,
      recordingDurationMs: 300000,
      artifactQuotaBytes: Number.MAX_SAFE_INTEGER,
      artifactTtlMs: 3600000,
      downloadMaxFileBytes: Number.MAX_SAFE_INTEGER,
      downloadMaxActive: Number.MAX_SAFE_INTEGER,
    });
    assert.deepEqual(await get(true), {
      enabled: false,
      autoInstall: true,
      diagnosticsEnabled: true,
      diagnosticsMaxEntries: 500,
      diagnosticsMaxBytes: 1048576,
      navigationTimeoutMs: 22000,
      profileWaitTimeoutMs: 30000,
      startupTimeoutMs: 180000,
      shutdownTimeoutMs: 5000,
      recordingDurationMs: 300000,
      artifactQuotaBytes: Number.MAX_SAFE_INTEGER,
      artifactTtlMs: 3600000,
      downloadMaxFileBytes: Number.MAX_SAFE_INTEGER,
      downloadMaxActive: Number.MAX_SAFE_INTEGER,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
