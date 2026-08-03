import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { join } from "node:path";
import {
  getSettingValue,
  publishExtensionSettings,
} from "../../lib/pi-tools-config.ts";
import { getRuntimeSettings } from "../../lib/pi-tools-runtime-settings.ts";
import { CodeSearchWorkerClient } from "./worker-client.ts";
import {
  CODE_SEARCH_EXTENSION_ID,
  CODE_SEARCH_SETTINGS,
  CODE_SEARCH_TOOL_NAMES,
  resolveCodeSearchMode,
  type CodeSearchMode,
} from "./settings.ts";

function removeCodeSearchTools(pi: ExtensionAPI): void {
  const codeSearchTools = new Set<string>(CODE_SEARCH_TOOL_NAMES);
  pi.setActiveTools(
    pi.getActiveTools().filter((toolName) => !codeSearchTools.has(toolName)),
  );
}

function addCodeSearchTools(pi: ExtensionAPI): void {
  pi.setActiveTools([
    ...new Set([...pi.getActiveTools(), ...CODE_SEARCH_TOOL_NAMES]),
  ]);
}

function unavailableResult(mode: CodeSearchMode) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          mode === "observe"
            ? "Code search is in observe mode; set code-search.mode to apply to expose retrieval tools."
            : "Code search runtime is not available.",
      },
    ],
    details: { mode },
    isError: true,
  };
}

export default function (pi: ExtensionAPI) {
  let mode: CodeSearchMode = "off";
  let worker: CodeSearchWorkerClient | undefined;

  async function stopWorker(): Promise<void> {
    const current = worker;
    worker = undefined;
    await current?.close();
  }

  function startWorker(
    cwd: string,
    additionalIgnores: string,
    watchEnabled: boolean,
  ): void {
    const current = new CodeSearchWorkerClient();
    worker = current;
    void current
      .initialize(join(cwd, CONFIG_DIR_NAME, "code-search", "index.sqlite"))
      .then(() => current.refresh({ root: cwd, additionalIgnores }))
      .then(() =>
        current.watch({ root: cwd, additionalIgnores, enabled: watchEnabled }),
      )
      .catch(async () => {
        if (worker === current) worker = undefined;
        await current.close();
      });
  }

  publishExtensionSettings(pi.events, CODE_SEARCH_SETTINGS);

  for (const [name, label] of [
    ["code_search", "Code Search"],
    ["code_outline", "Code Outline"],
    ["code_get", "Get Code"],
    ["code_context", "Code Context"],
  ] as const) {
    pi.registerTool({
      name,
      label,
      description: "AST-aware local code navigation (initializing).",
      parameters: Type.Object({}),
      async execute() {
        return unavailableResult(mode);
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    await stopWorker();
    // A global extension has full Node permissions. Do not rely on Pi trust to
    // enforce this boundary: no project settings, state, work, or active tools
    // are allowed until the current project is trusted.
    if (!ctx.isProjectTrusted()) {
      mode = "off";
      removeCodeSearchTools(pi);
      return;
    }

    const settings = await getRuntimeSettings(ctx, CONFIG_DIR_NAME);
    mode = resolveCodeSearchMode(
      getSettingValue(settings, CODE_SEARCH_EXTENSION_ID, "mode"),
    );
    if (mode === "apply") addCodeSearchTools(pi);
    else removeCodeSearchTools(pi);
    if (mode !== "off") {
      startWorker(
        ctx.cwd,
        String(
          getSettingValue(
            settings,
            CODE_SEARCH_EXTENSION_ID,
            "index.additionalIgnores",
          ),
        ),
        Boolean(
          getSettingValue(settings, CODE_SEARCH_EXTENSION_ID, "index.watch"),
        ),
      );
    }
  });

  pi.on("session_shutdown", async () => {
    await stopWorker();
  });
}
