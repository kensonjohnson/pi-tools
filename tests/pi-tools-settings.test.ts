import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE_NAME } from "../lib/pi-tools-config.ts";
import {
  SETTINGS_DEFINITION_EVENT,
  SETTINGS_DEFINITION_REQUEST_EVENT,
} from "../lib/pi-tools-config.ts";
import extension from "../extensions/pi-tools-settings.ts";

initTheme();

type CustomComponent = {
  render(width: number): string[];
  handleInput(data: string): void;
};

function visible(component: CustomComponent): string {
  return component.render(100).join("\n");
}

test(
  "navigates extension settings without losing the selected write scope",
  { timeout: 2_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tools-settings-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");

    try {
      const handlers = new Map<string, Array<(data: unknown) => void>>();
      let command:
        { handler: (args: string, ctx: any) => Promise<void> } | undefined;
      let component: CustomComponent | undefined;
      let doneCalls = 0;
      let reloads = 0;
      let customReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        customReady = resolve;
      });

      const pi = {
        events: {
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
                listeners.filter((listener) => listener !== handler),
              );
          },
        },
        registerCommand(
          name: string,
          registration: { handler: (args: string, ctx: any) => Promise<void> },
        ) {
          if (name === "pi-tools") command = registration;
        },
      } as unknown as ExtensionAPI;
      extension(pi);

      pi.events.on(SETTINGS_DEFINITION_REQUEST_EVENT, () => {
        pi.events.emit(SETTINGS_DEFINITION_EVENT, {
          id: "alpha",
          label: "Alpha",
          description: "Alpha extension settings",
          fields: {
            enabled: { type: "boolean", default: true },
            mode: { type: "enum", default: "safe", values: ["safe", "fast"] },
          },
        });
      });

      assert.ok(command, "expected the pi-tools command to register");
      const open = command.handler("", {
        mode: "tui",
        cwd: join(root, "project"),
        isProjectTrusted: () => true,
        reload: async () => {
          reloads += 1;
        },
        ui: {
          notify() {},
          custom: async (factory: any) => {
            return new Promise<void>((resolve) => {
              component = factory(
                { requestRender() {} },
                {
                  fg: (_color: string, text: string) => text,
                  bold: (text: string) => text,
                },
                {},
                () => {
                  doneCalls += 1;
                  resolve();
                },
              );
              customReady();
            });
          },
        },
      });
      await ready;
      assert.ok(component, "expected the settings UI to open");

      const rootScreen = visible(component);
      assert.match(rootScreen, /Write scope/);
      assert.match(rootScreen, /Alpha/);
      assert.doesNotMatch(rootScreen, /Mode/);

      component.handleInput("\r");
      component.handleInput("\u001b[B");
      component.handleInput("\r");
      const detailScreen = visible(component);
      assert.match(detailScreen, /Pi-tools Settings — Alpha/);
      assert.match(detailScreen, /enabled/);
      assert.match(detailScreen, /mode/);

      component.handleInput("\u001b[B");
      component.handleInput("\r");
      component.handleInput("\u001b");
      assert.equal(doneCalls, 0, "detail Esc should return to the root screen");
      assert.doesNotMatch(visible(component), /\bmode\b/);

      component.handleInput("\u001b");
      await open;
      assert.equal(doneCalls, 1, "root Esc should close the custom UI");
      assert.equal(reloads, 1, "saved settings reload after the UI closes");

      const projectConfig = JSON.parse(
        await readFile(join(root, "project", ".pi", CONFIG_FILE_NAME), "utf8"),
      );
      assert.deepEqual(projectConfig, {
        version: 1,
        extensions: { alpha: { mode: "fast" } },
      });
      await assert.rejects(
        readFile(join(root, "agent", CONFIG_FILE_NAME), "utf8"),
        /ENOENT/,
      );
    } finally {
      if (originalAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  },
);
