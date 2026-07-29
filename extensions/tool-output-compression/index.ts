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

const tracker = new ObservationTracker();
let settings: CompressionSettings = {
  enabled: true,
  mode: DEFAULT_MODE,
  eligibleTools: parseEligibleTools(DEFAULT_ELIGIBLE_TOOLS),
};

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
}

function dashboardData(): DashboardData {
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    eligibleTools: settings.eligibleTools,
    metrics: tracker.snapshot(),
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
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    tracker.reset();
    await loadSettings(ctx);
  });

  pi.on("tool_result", (event) => {
    // Observation intentionally returns no patch: every Pi result remains intact.
    tracker.observe(event, settings);
  });

  pi.registerCommand("tool-output", {
    description: "Show tool-output compression token-savings dashboard",
    handler: async (_args, ctx) => {
      const data = dashboardData();
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
