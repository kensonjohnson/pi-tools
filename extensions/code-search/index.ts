import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
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
import {
  registerCodeSearchTools,
  type CodeSearchToolRuntime,
} from "./tools.ts";

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

export default function (pi: ExtensionAPI) {
  let mode: CodeSearchMode = "off";
  let runtime: CodeSearchToolRuntime | undefined;

  async function stopWorker(): Promise<void> {
    const current = runtime;
    runtime = undefined;
    await current?.worker.close();
  }

  function startWorker(
    next: CodeSearchToolRuntime,
    watchEnabled: boolean,
  ): void {
    runtime = next;
    void next.worker
      .initialize(
        join(next.root, CONFIG_DIR_NAME, "code-search", "index.sqlite"),
        next.root,
      )
      .then(() =>
        next.worker.refresh({
          root: next.root,
          additionalIgnores: next.additionalIgnores,
        }),
      )
      .then(() =>
        next.worker.watch({
          root: next.root,
          additionalIgnores: next.additionalIgnores,
          enabled: watchEnabled,
        }),
      )
      .catch(async () => {
        if (runtime === next) runtime = undefined;
        await next.worker.close();
      });
  }

  publishExtensionSettings(pi.events, CODE_SEARCH_SETTINGS);
  registerCodeSearchTools(pi, () => (mode === "apply" ? runtime : undefined));

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
    if (mode === "off") return;

    startWorker(
      {
        root: ctx.cwd,
        additionalIgnores: String(
          getSettingValue(
            settings,
            CODE_SEARCH_EXTENSION_ID,
            "index.additionalIgnores",
          ),
        ),
        outputStyle:
          getSettingValue(
            settings,
            CODE_SEARCH_EXTENSION_ID,
            "output.style",
          ) === "structured"
            ? "structured"
            : "compact",
        searchMaxResults: Number(
          getSettingValue(
            settings,
            CODE_SEARCH_EXTENSION_ID,
            "search.maxResults",
          ),
        ),
        searchTokenBudget: Number(
          getSettingValue(
            settings,
            CODE_SEARCH_EXTENSION_ID,
            "search.tokenBudget",
          ),
        ),
        retrievalTokenBudget: Number(
          getSettingValue(
            settings,
            CODE_SEARCH_EXTENSION_ID,
            "retrieval.tokenBudget",
          ),
        ),
        contextTokenBudget: Number(
          getSettingValue(
            settings,
            CODE_SEARCH_EXTENSION_ID,
            "context.tokenBudget",
          ),
        ),
        worker: new CodeSearchWorkerClient(),
      },
      Boolean(
        getSettingValue(settings, CODE_SEARCH_EXTENSION_ID, "index.watch"),
      ),
    );
  });

  pi.on("session_shutdown", async () => {
    await stopWorker();
  });
}
