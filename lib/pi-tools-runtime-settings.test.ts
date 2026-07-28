import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CONFIG_FILE_NAME,
  settingsRegistry,
} from "./pi-tools-config.ts";
import {
  isExtensionEnabled,
  removeDisabledTools,
} from "./pi-tools-runtime-settings.ts";

test("removes only disabled extension tools from Pi's active tool set", () => {
  let active = ["read", "alpha_tool", "beta_tool"];
  const pi = {
    getActiveTools: () => active,
    setActiveTools: (toolNames: string[]) => {
      active = toolNames;
    },
  };

  removeDisabledTools(pi, ["alpha_tool"], false);
  assert.deepEqual(active, ["read", "beta_tool"]);
  removeDisabledTools(pi, ["beta_tool"], true);
  assert.deepEqual(active, ["read", "beta_tool"]);
});

test("resolves extension enablement through the trusted project config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-runtime-"));
  try {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    settingsRegistry.register({
      id: "alpha",
      label: "Alpha",
      fields: { enabled: { type: "boolean", default: true } },
    });
    const globalPath = join(agentDir, CONFIG_FILE_NAME);
    const projectPath = join(cwd, ".pi", CONFIG_FILE_NAME);
    await mkdir(dirname(globalPath), { recursive: true });
    await mkdir(dirname(projectPath), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify({ version: 1, extensions: { alpha: { enabled: true } } }),
      "utf8",
    );
    await writeFile(
      projectPath,
      JSON.stringify({ version: 1, extensions: { alpha: { enabled: false } } }),
      "utf8",
    );

    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      assert.equal(
        await isExtensionEnabled(
          { cwd, isProjectTrusted: () => false },
          ".pi",
          "alpha",
        ),
        true,
      );
      assert.equal(
        await isExtensionEnabled(
          { cwd, isProjectTrusted: () => true },
          ".pi",
          "alpha",
        ),
        false,
      );
    } finally {
      if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = original;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
