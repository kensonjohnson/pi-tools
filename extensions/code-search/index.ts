import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getEffectiveSettings,
  getSettingValue,
  publishExtensionSettings,
} from "../../lib/pi-tools-config.ts";
import { getRuntimeSettings } from "../../lib/pi-tools-runtime-settings.ts";
import { formatCodeSearchDashboard } from "./dashboard.ts";
import { CodeSearchMetricsStore } from "./metrics.ts";
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

function globalMetricsPath(): string {
  return join(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    "code-search-metrics.sqlite",
  );
}

export default function (pi: ExtensionAPI) {
  let mode: CodeSearchMode = "off";
  let runtime: CodeSearchToolRuntime | undefined;
  let retentionDays = 90;

  async function stopWorker(): Promise<void> {
    const current = runtime;
    runtime = undefined;
    await current?.worker.close();
    current?.metrics?.close();
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
      .then((status) => {
        next.metrics?.record({
          mode: next.mode,
          event: "session",
          freshness: status.freshness,
        });
        return next.worker.watch({
          root: next.root,
          additionalIgnores: next.additionalIgnores,
          enabled: watchEnabled,
        });
      })
      .catch(async () => {
        if (runtime === next) runtime = undefined;
        await next.worker.close();
        next.metrics?.close();
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

    // Metrics aggregate extension-wide usage, so their retention must use the
    // global setting rather than a trusted-project override.
    const globalSettings = await getEffectiveSettings({
      cwd: ctx.cwd,
      projectTrusted: false,
      configDirName: CONFIG_DIR_NAME,
    });
    retentionDays = Number(
      getSettingValue(
        globalSettings,
        CODE_SEARCH_EXTENSION_ID,
        "metrics.retentionDays",
      ),
    );
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
        mode,
        metrics: new CodeSearchMetricsStore({
          path: globalMetricsPath(),
          retentionDays,
        }),
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

  pi.registerCommand("code-search", {
    description: "Show and maintain local code-search metrics",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action && action !== "prune") {
        ctx.ui.notify("Usage: /code-search [prune]", "warning");
        return;
      }
      if (action === "prune") {
        const removed = runtime?.metrics?.prune() ?? 0;
        ctx.ui.notify(
          `Pruned ${removed} expired code-search metric row${removed === 1 ? "" : "s"}.`,
          "info",
        );
        return;
      }
      let status;
      try {
        status = await runtime?.worker.status();
      } catch {
        // A dashboard must remain useful if the index is still starting.
      }
      ctx.ui.notify(
        formatCodeSearchDashboard({
          mode,
          retentionDays,
          rows: runtime?.metrics?.rows() ?? [],
          status,
        }),
        "info",
      );
    },
  });
}
