import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import {
  getSettingValue,
  publishExtensionSettings,
  type ExtensionSettingsDefinition,
} from "../lib/pi-tools-config.ts";
import { getRuntimeSettings } from "../lib/pi-tools-runtime-settings.ts";
export const MAIN_WORKING_SPINNER_SETTINGS_ID = "main-working-spinner";
export const DEFAULT_WORKING_INDICATOR_PRESET = "Pulse";
export const DEFAULT_WORKING_INDICATOR_INTERVAL_MS = 100;

export const WORKING_INDICATOR_PRESETS = [
  "Pulse",
  "Sand",
  "Static",
  "Bouncing bar",
  "Bouncing ball",
  "Pong",
  "Chasing dots",
  "Orbit",
  "Line",
  "Star",
  "Corners",
  "Quarters",
  "Halves",
  "Arrows",
] as const;

type WorkingIndicatorPreset = (typeof WORKING_INDICATOR_PRESETS)[number];

export const WORKING_INDICATOR_FRAMES: Record<
  WorkingIndicatorPreset,
  readonly string[]
> = {
  Pulse: ["·", "•", "●", "•"],
  Sand: [
    "⠁",
    "⠂",
    "⠄",
    "⡀",
    "⡈",
    "⡐",
    "⡠",
    "⣀",
    "⣁",
    "⣂",
    "⣄",
    "⣌",
    "⣔",
    "⣤",
    "⣥",
    "⣦",
    "⣮",
    "⣶",
    "⣷",
    "⣿",
    "⡿",
    "⠿",
    "⢟",
    "⠟",
    "⡛",
    "⠛",
    "⠫",
    "⢋",
    "⠋",
    "⠍",
    "⡉",
    "⠉",
    "⠑",
    "⠡",
    "⢁",
  ],
  Static: ["●"],
  "Bouncing bar": [
    "[    ]",
    "[=   ]",
    "[==  ]",
    "[=== ]",
    "[====]",
    "[ ===]",
    "[  ==]",
    "[   =]",
    "[    ]",
    "[   =]",
    "[  ==]",
    "[ ===]",
    "[====]",
    "[=== ]",
    "[==  ]",
    "[=   ]",
  ],
  "Bouncing ball": [
    "( ●    )",
    "(  ●   )",
    "(   ●  )",
    "(    ● )",
    "(     ●)",
    "(    ● )",
    "(   ●  )",
    "(  ●   )",
    "( ●    )",
    "(●     )",
  ],
  Pong: [
    "▐⠂       ▌",
    "▐⠈       ▌",
    "▐ ⠂      ▌",
    "▐ ⠠      ▌",
    "▐  ⡀     ▌",
    "▐  ⠠     ▌",
    "▐   ⠂    ▌",
    "▐   ⠈    ▌",
    "▐    ⠂   ▌",
    "▐    ⠠   ▌",
    "▐     ⡀  ▌",
    "▐     ⠠  ▌",
    "▐      ⠂ ▌",
    "▐      ⠈ ▌",
    "▐       ⠂▌",
    "▐       ⠠▌",
    "▐       ⡀▌",
    "▐      ⠠ ▌",
    "▐      ⠂ ▌",
    "▐     ⠈  ▌",
    "▐     ⠂  ▌",
    "▐    ⠠   ▌",
    "▐    ⡀   ▌",
    "▐   ⠠    ▌",
    "▐   ⠂    ▌",
    "▐  ⠈     ▌",
    "▐  ⠂     ▌",
    "▐ ⠠      ▌",
    "▐ ⡀      ▌",
    "▐⠠       ▌",
  ],
  "Chasing dots": ["∙∙∙", "●∙∙", "∙●∙", "∙∙●", "∙∙∙"],
  Orbit: [
    "⢀⠀",
    "⡀⠀",
    "⠄⠀",
    "⢂⠀",
    "⡂⠀",
    "⠅⠀",
    "⢃⠀",
    "⡃⠀",
    "⠍⠀",
    "⢋⠀",
    "⡋⠀",
    "⠍⠁",
    "⢋⠁",
    "⡋⠁",
    "⠍⠉",
    "⠋⠉",
    "⠋⠉",
    "⠉⠙",
    "⠉⠙",
    "⠉⠩",
    "⠈⢙",
    "⠈⡙",
    "⢈⠩",
    "⡀⢙",
    "⠄⡙",
    "⢂⠩",
    "⡂⢘",
    "⠅⡘",
    "⢃⠨",
    "⡃⢐",
    "⠍⡐",
    "⢋⠠",
    "⡋⢀",
    "⠍⡁",
    "⢋⠁",
    "⡋⠁",
    "⠍⠉",
    "⠋⠉",
    "⠋⠉",
    "⠉⠙",
    "⠉⠙",
    "⠉⠩",
    "⠈⢙",
    "⠈⡙",
    "⠈⠩",
    "⠀⢙",
    "⠀⡙",
    "⠀⠩",
    "⠀⢘",
    "⠀⡘",
    "⠀⠨",
    "⠀⢐",
    "⠀⡐",
    "⠀⠠",
    "⠀⢀",
    "⠀⡀",
  ],
  Line: ["-", "\\", "|", "/"],
  Star: ["✶", "✸", "✹", "✺", "✹", "✷"],
  Corners: ["◰", "◳", "◲", "◱"],
  Quarters: ["◴", "◷", "◶", "◵"],
  Halves: ["◐", "◓", "◑", "◒"],
  Arrows: ["▹▹▹▹▹", "▸▹▹▹▹", "▹▸▹▹▹", "▹▹▸▹▹", "▹▹▹▸▹", "▹▹▹▹▸"],
};

export const MAIN_WORKING_SPINNER_SETTINGS = {
  id: MAIN_WORKING_SPINNER_SETTINGS_ID,
  label: "Main Working Spinner",
  description: "Controls the main TUI working indicator.",
  fields: {
    enabled: { type: "boolean", default: true, label: "Enabled" },
    preset: {
      type: "enum",
      default: DEFAULT_WORKING_INDICATOR_PRESET,
      values: WORKING_INDICATOR_PRESETS,
      label: "Spinner preset",
    },
    intervalMs: {
      type: "number",
      default: DEFAULT_WORKING_INDICATOR_INTERVAL_MS,
      minimum: 1,
      integer: true,
      label: "Spinner interval (ms)",
      description:
        "Frame delay for animated presets; Static ignores this value.",
    },
  },
} satisfies ExtensionSettingsDefinition;

function isWorkingIndicatorPreset(
  value: unknown,
): value is WorkingIndicatorPreset {
  return (
    typeof value === "string" &&
    (WORKING_INDICATOR_PRESETS as readonly string[]).includes(value)
  );
}

export function resolveWorkingIndicatorOptions(
  preset: unknown,
  intervalMs: unknown,
): WorkingIndicatorOptions {
  const resolvedPreset = isWorkingIndicatorPreset(preset)
    ? preset
    : DEFAULT_WORKING_INDICATOR_PRESET;
  const frames = [...WORKING_INDICATOR_FRAMES[resolvedPreset]];
  if (resolvedPreset === "Static") return { frames };

  return {
    frames,
    intervalMs:
      typeof intervalMs === "number" &&
      Number.isInteger(intervalMs) &&
      intervalMs > 0
        ? intervalMs
        : DEFAULT_WORKING_INDICATOR_INTERVAL_MS,
  };
}

/** Owns only the main TUI's working spinner, never text or worker sessions. */
export default function (pi: ExtensionAPI) {
  let active = false;
  let lifecycle = 0;
  let workingUI:
    Pick<ExtensionContext["ui"], "setWorkingIndicator"> | undefined;

  const restoreDefaultIndicator = () => workingUI?.setWorkingIndicator();

  publishExtensionSettings(pi.events, MAIN_WORKING_SPINNER_SETTINGS);

  pi.on("session_start", async (_event, ctx) => {
    const currentLifecycle = ++lifecycle;
    active = ctx.hasUI && ctx.mode === "tui";
    workingUI = active ? ctx.ui : undefined;
    if (!active) return;

    const settings = await getRuntimeSettings(ctx, CONFIG_DIR_NAME);
    if (!active || lifecycle !== currentLifecycle) return;

    const enabled =
      getSettingValue<boolean>(
        settings,
        MAIN_WORKING_SPINNER_SETTINGS_ID,
        "enabled",
      ) !== false;
    if (!enabled) {
      restoreDefaultIndicator();
      return;
    }

    workingUI?.setWorkingIndicator(
      resolveWorkingIndicatorOptions(
        getSettingValue(settings, MAIN_WORKING_SPINNER_SETTINGS_ID, "preset"),
        getSettingValue(
          settings,
          MAIN_WORKING_SPINNER_SETTINGS_ID,
          "intervalMs",
        ),
      ),
    );
  });

  pi.on("session_shutdown", () => {
    ++lifecycle;
    restoreDefaultIndicator();
    active = false;
    workingUI = undefined;
  });
}
