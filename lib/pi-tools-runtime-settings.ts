import {
  getSettingValue,
  getEffectiveSettings,
  type EffectiveSettings,
} from "./pi-tools-config.ts";

export type PiToolsSettingsContext = {
  cwd: string;
  isProjectTrusted(): boolean;
};

export type ActiveToolsAPI = {
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
};

export async function getRuntimeSettings(
  ctx: PiToolsSettingsContext,
  configDirName: string,
): Promise<EffectiveSettings> {
  return getEffectiveSettings({
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    configDirName,
  });
}

export async function isExtensionEnabled(
  ctx: PiToolsSettingsContext,
  configDirName: string,
  extensionId: string,
): Promise<boolean> {
  const settings = await getRuntimeSettings(ctx, configDirName);
  return getSettingValue<boolean>(settings, extensionId, "enabled") !== false;
}

export function removeDisabledTools(
  pi: ActiveToolsAPI,
  toolNames: readonly string[],
  enabled: boolean,
): void {
  if (enabled) return;
  const disabled = new Set(toolNames);
  pi.setActiveTools(
    pi.getActiveTools().filter((toolName) => !disabled.has(toolName)),
  );
}
