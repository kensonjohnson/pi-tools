import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, {
  DEFAULT_WORKING_INDICATOR_INTERVAL_MS,
  MAIN_WORKING_SPINNER_SETTINGS,
  WORKING_INDICATOR_FRAMES,
  WORKING_INDICATOR_PRESETS,
  resolveWorkingIndicatorOptions,
} from "../main-working-spinner.ts";

type Handler = (event: unknown, ctx: any) => unknown;

function createExtensionHarness() {
  const handlers = new Map<string, Handler>();
  const indicators: Array<unknown> = [];
  const messages: Array<string | undefined> = [];
  const pi = {
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  extension(pi as unknown as ExtensionAPI);
  return {
    handlers,
    indicators,
    messages,
    ui: {
      setWorkingIndicator(options?: unknown) {
        indicators.push(options);
      },
      setWorkingMessage(message?: string) {
        messages.push(message);
      },
    },
  };
}

test("main TUI applies its configured spinner without changing working text", async () => {
  const { handlers, indicators, messages, ui } = createExtensionHarness();
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    isProjectTrusted: () => false,
    mode: "tui",
    ui,
  };

  await handlers.get("session_start")?.({}, ctx);
  assert.deepEqual(indicators, [
    {
      frames: [...WORKING_INDICATOR_FRAMES.Pulse],
      intervalMs: DEFAULT_WORKING_INDICATOR_INTERVAL_MS,
    },
  ]);
  assert.deepEqual(messages, []);

  handlers.get("session_shutdown")?.({}, ctx);
  assert.deepEqual(indicators.at(-1), undefined);
  assert.deepEqual(messages, []);
});

test("headless and RPC sessions do not own the working spinner", async () => {
  for (const ctx of [
    { hasUI: false, mode: "print" },
    { hasUI: true, mode: "rpc" },
  ]) {
    const { handlers, indicators, messages, ui } = createExtensionHarness();
    await handlers.get("session_start")?.(
      {},
      {
        ...ctx,
        cwd: process.cwd(),
        isProjectTrusted: () => false,
        ui,
      },
    );
    assert.deepEqual(indicators, []);
    assert.deepEqual(messages, []);
  }
});

test("registers all approved presets and treats Static as non-animated", () => {
  assert.deepEqual(Object.keys(MAIN_WORKING_SPINNER_SETTINGS.fields), [
    "enabled",
    "preset",
    "intervalMs",
  ]);
  assert.deepEqual(
    MAIN_WORKING_SPINNER_SETTINGS.fields.preset.values,
    WORKING_INDICATOR_PRESETS,
  );
  assert.equal(MAIN_WORKING_SPINNER_SETTINGS.fields.intervalMs.integer, true);
  assert.equal(MAIN_WORKING_SPINNER_SETTINGS.fields.intervalMs.minimum, 1);
  assert.equal(WORKING_INDICATOR_FRAMES.Sand.length, 35);
  assert.equal(WORKING_INDICATOR_FRAMES.Pong.length, 30);
  assert.equal(WORKING_INDICATOR_FRAMES.Orbit.length, 56);
  assert.deepEqual(resolveWorkingIndicatorOptions("Static", 250), {
    frames: ["●"],
  });
  assert.deepEqual(resolveWorkingIndicatorOptions("Orbit", 250), {
    frames: [...WORKING_INDICATOR_FRAMES.Orbit],
    intervalMs: 250,
  });
});

test("uses trusted scoped settings and restores Pi's indicator while disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-working-spinner-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const globalPath = join(agentDir, "pi-tools.json");
  const projectPath = join(cwd, ".pi", "pi-tools.json");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    await mkdir(dirname(globalPath), { recursive: true });
    await mkdir(dirname(projectPath), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify({
        version: 1,
        extensions: {
          "main-working-spinner": { preset: "Pulse", intervalMs: 75 },
        },
      }),
      "utf8",
    );
    await writeFile(
      projectPath,
      JSON.stringify({
        version: 1,
        extensions: {
          "main-working-spinner": { preset: "Pong", intervalMs: 250 },
        },
      }),
      "utf8",
    );

    const enabled = createExtensionHarness();
    const enabledCtx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      mode: "tui",
      ui: enabled.ui,
    };
    await enabled.handlers.get("session_start")?.({}, enabledCtx);
    assert.deepEqual(enabled.indicators, [
      { frames: [...WORKING_INDICATOR_FRAMES.Pong], intervalMs: 250 },
    ]);
    assert.deepEqual(enabled.messages, []);

    await writeFile(
      projectPath,
      JSON.stringify({
        version: 1,
        extensions: { "main-working-spinner": { enabled: false } },
      }),
      "utf8",
    );
    const disabled = createExtensionHarness();
    await disabled.handlers.get("session_start")?.(
      {},
      { ...enabledCtx, ui: disabled.ui },
    );
    assert.deepEqual(disabled.indicators, [undefined]);
    assert.deepEqual(disabled.messages, []);
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
