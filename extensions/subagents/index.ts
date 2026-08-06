import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { publishExtensionSettings } from "../../lib/pi-tools-config.ts";
import {
  isExtensionEnabled,
  removeDisabledTools,
} from "../../lib/pi-tools-runtime-settings.ts";
import {
  SUBAGENTS_EXTENSION_ID,
  SUBAGENT_SETTINGS,
  SUBAGENT_TOOL_NAMES,
} from "./settings.ts";

export default function (pi: ExtensionAPI) {
  publishExtensionSettings(pi.events, SUBAGENT_SETTINGS);

  pi.on("session_start", async (_event, ctx) => {
    removeDisabledTools(
      pi,
      SUBAGENT_TOOL_NAMES,
      await isExtensionEnabled(ctx, CONFIG_DIR_NAME, SUBAGENTS_EXTENSION_ID),
    );
  });
}
