import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getSettingValue,
  publishExtensionSettings,
} from "../../lib/pi-tools-config.ts";
import { getRuntimeSettings } from "../../lib/pi-tools-runtime-settings.ts";
import {
  DEFAULT_ELIGIBLE_TOOLS,
  DEFAULT_MODE,
  ObservationTracker,
  TOOL_OUTPUT_COMPRESSION_ID,
  parseEligibleTools,
  resolveCompressionMode,
  type CompressionSettings,
} from "./core.ts";
import {
  createDashboardComponent,
  formatDashboard,
  type DashboardData,
} from "./dashboard.ts";
import { RETRIEVE_TOOL_OUTPUT_NAME, registerRetrieveTool } from "./retrieve.ts";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_RETRIEVAL_MAX_BYTES,
  DEFAULT_STORAGE_MAX_BYTES,
  DEFAULT_STORAGE_RETENTION_DAYS,
  MAX_RETRIEVAL_MAX_BYTES,
  ToolOutputStore,
  type StorageSettings,
} from "./store.ts";

const DEFAULT_DATABASE_PATH = join(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  "tool-output-compression.sqlite",
);
const RETRIEVAL_TOOL_NAMES = [RETRIEVE_TOOL_OUTPUT_NAME] as const;

const tracker = new ObservationTracker();
let settings: CompressionSettings = {
  enabled: true,
  mode: DEFAULT_MODE,
  eligibleTools: parseEligibleTools(DEFAULT_ELIGIBLE_TOOLS),
};
let storageSettings: StorageSettings = {
  path: DEFAULT_DATABASE_PATH,
  maxBytes: DEFAULT_STORAGE_MAX_BYTES,
  retentionDays: DEFAULT_STORAGE_RETENTION_DAYS,
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  retrievalMaxBytes: DEFAULT_RETRIEVAL_MAX_BYTES,
};
let store: ToolOutputStore | undefined;

async function loadSettings(ctx: ExtensionContext): Promise<void> {
  const runtime = await getRuntimeSettings(ctx, CONFIG_DIR_NAME);
  settings = {
    enabled:
      getSettingValue<boolean>(
        runtime,
        TOOL_OUTPUT_COMPRESSION_ID,
        "enabled",
      ) !== false,
    mode: resolveCompressionMode(
      getSettingValue<string>(runtime, TOOL_OUTPUT_COMPRESSION_ID, "mode"),
    ),
    eligibleTools: parseEligibleTools(
      getSettingValue<string>(
        runtime,
        TOOL_OUTPUT_COMPRESSION_ID,
        "eligibleTools",
      ) ?? DEFAULT_ELIGIBLE_TOOLS,
    ),
  };
  storageSettings = {
    path: resolveStoragePath(
      getSettingValue<string>(
        runtime,
        TOOL_OUTPUT_COMPRESSION_ID,
        "storage.path",
      ) ?? DEFAULT_DATABASE_PATH,
    ),
    maxBytes:
      getSettingValue<number>(
        runtime,
        TOOL_OUTPUT_COMPRESSION_ID,
        "storage.maxBytes",
      ) ?? DEFAULT_STORAGE_MAX_BYTES,
    retentionDays:
      getSettingValue<number>(
        runtime,
        TOOL_OUTPUT_COMPRESSION_ID,
        "storage.retentionDays",
      ) ?? DEFAULT_STORAGE_RETENTION_DAYS,
    maxOutputBytes:
      getSettingValue<number>(
        runtime,
        TOOL_OUTPUT_COMPRESSION_ID,
        "storage.maxOutputBytes",
      ) ?? DEFAULT_MAX_OUTPUT_BYTES,
    retrievalMaxBytes:
      getSettingValue<number>(
        runtime,
        TOOL_OUTPUT_COMPRESSION_ID,
        "retrieval.maxBytes",
      ) ?? DEFAULT_RETRIEVAL_MAX_BYTES,
  };
}

function resolveStoragePath(value: string): string {
  const path = value.trim();
  if (!path) return DEFAULT_DATABASE_PATH;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function getStore(): ToolOutputStore {
  if (store && store.settings.path === storageSettings.path) return store;
  void store?.close();
  store = new ToolOutputStore(storageSettings);
  return store;
}

async function dashboardData(): Promise<DashboardData> {
  let storage;
  try {
    storage = await getStore().stats();
  } catch {
    // Reporting must not make observation or retrieval fail when storage is unavailable.
  }
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    eligibleTools: settings.eligibleTools,
    metrics: tracker.snapshot(),
    storage,
  };
}

export default function (pi: ExtensionAPI) {
  publishExtensionSettings(pi.events, {
    id: TOOL_OUTPUT_COMPRESSION_ID,
    label: "Tool Output Compression",
    description:
      "Observes configured text tool output and reports exact-reuse token savings.",
    fields: {
      enabled: {
        type: "boolean",
        default: true,
        label: "Enabled",
      },
      mode: {
        type: "enum",
        default: DEFAULT_MODE,
        values: ["off", "observe", "apply"],
        label: "Mode",
        description:
          "Observe is non-mutating. Apply remains observational until exact reuse ships.",
      },
      eligibleTools: {
        type: "string",
        default: DEFAULT_ELIGIBLE_TOOLS,
        label: "Eligible tools",
        description:
          "Comma-separated tool names eligible for exact-reuse analysis.",
      },
      "storage.path": {
        type: "string",
        default: DEFAULT_DATABASE_PATH,
        label: "Database path",
        description:
          "Private SQLite database path for durable raw tool output.",
      },
      "storage.maxBytes": {
        type: "number",
        default: DEFAULT_STORAGE_MAX_BYTES,
        minimum: 1_024 * 1_024,
        maximum: 4 * 1_024 * 1_024 * 1_024,
        label: "Raw-output quota (bytes)",
      },
      "storage.retentionDays": {
        type: "number",
        default: DEFAULT_STORAGE_RETENTION_DAYS,
        minimum: 1,
        maximum: 3_650,
        label: "Retention (days)",
      },
      "storage.maxOutputBytes": {
        type: "number",
        default: DEFAULT_MAX_OUTPUT_BYTES,
        minimum: 1_024,
        maximum: 50 * 1_024 * 1_024,
        label: "Per-output limit (bytes)",
      },
      "retrieval.maxBytes": {
        type: "number",
        default: DEFAULT_RETRIEVAL_MAX_BYTES,
        minimum: 1_024,
        maximum: MAX_RETRIEVAL_MAX_BYTES,
        label: "Retrieval chunk (bytes)",
      },
    },
    toolNames: RETRIEVAL_TOOL_NAMES,
  });

  registerRetrieveTool(pi, getStore);

  pi.on("session_start", async (_event, ctx) => {
    tracker.reset();
    await loadSettings(ctx);
    if (!settings.enabled) {
      pi.setActiveTools(
        pi
          .getActiveTools()
          .filter((toolName) => !RETRIEVAL_TOOL_NAMES.includes(toolName)),
      );
    }
  });

  pi.on("session_shutdown", async () => {
    await store?.close();
    store = undefined;
  });

  pi.on("tool_result", (event) => {
    // Observation intentionally returns no patch: every Pi result remains intact.
    tracker.observe(event, settings);
  });

  pi.registerCommand("tool-output", {
    description: "Show and maintain tool-output compression storage",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "prune") {
        const removed = await getStore().prune();
        ctx.ui.notify(
          `Pruned ${removed} expired stored tool output${removed === 1 ? "" : "s"}.`,
          "info",
        );
        return;
      }
      if (action === "vacuum") {
        await getStore().vacuum();
        ctx.ui.notify("Compacted the tool-output SQLite database.", "info");
        return;
      }
      if (action) {
        ctx.ui.notify("Usage: /tool-output [prune|vacuum]", "warning");
        return;
      }

      const data = await dashboardData();
      if (ctx.mode !== "tui") {
        ctx.ui.notify(formatDashboard(data), "info");
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _keybindings, done) =>
        createDashboardComponent(data, theme, done),
      );
    },
  });
}
