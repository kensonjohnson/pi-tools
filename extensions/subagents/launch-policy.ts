import {
  CONFIG_DIR_NAME,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getEffectiveSettings,
  getSettingValue,
  type SettingsRegistry,
} from "../../lib/pi-tools-config.ts";
import {
  modelFieldForWorkstream,
  SUBAGENTS_EXTENSION_ID,
  type SubagentWorkstreamKind,
} from "./settings.ts";

export type SubagentLaunchContext = Pick<
  ExtensionContext,
  | "cwd"
  | "isProjectTrusted"
  | "model"
  | "thinkingLevel"
  | "modelRegistry"
  | "scopedModels"
>;

export type ResolvedSubagentModel = {
  model: NonNullable<ExtensionContext["model"]>;
  thinkingLevel?: NonNullable<ExtensionContext["thinkingLevel"]>;
  source: "inherit" | "configured";
};

export type SubagentLaunchPolicy = {
  maxConcurrentWorkers: number;
  model: ResolvedSubagentModel;
};

export async function resolveSubagentLaunchPolicy(
  ctx: SubagentLaunchContext,
  kind: SubagentWorkstreamKind,
  options: { configDirName?: string; registry?: SettingsRegistry } = {},
): Promise<SubagentLaunchPolicy> {
  if (!ctx.isProjectTrusted()) {
    throw new Error("Subagents can run only in a trusted project.");
  }

  const settings = await getEffectiveSettings({
    cwd: ctx.cwd,
    projectTrusted: true,
    configDirName: options.configDirName ?? CONFIG_DIR_NAME,
    registry: options.registry,
  });
  const enabled = getSettingValue<boolean>(
    settings,
    SUBAGENTS_EXTENSION_ID,
    "enabled",
  );
  if (enabled === false) {
    throw new Error("Subagents are disabled in pi-tools settings.");
  }

  const maxConcurrentWorkers = getSettingValue<number>(
    settings,
    SUBAGENTS_EXTENSION_ID,
    "maxConcurrentWorkers",
  );
  if (!Number.isSafeInteger(maxConcurrentWorkers) || maxConcurrentWorkers < 1) {
    throw new Error(
      "Subagents maximum concurrent workers must be a positive integer.",
    );
  }

  const configuredModel = getSettingValue<string>(
    settings,
    SUBAGENTS_EXTENSION_ID,
    modelFieldForWorkstream(kind),
  );
  return {
    maxConcurrentWorkers,
    model: resolveSubagentModel(ctx, kind, configuredModel),
  };
}

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

type AvailableModel = NonNullable<ExtensionContext["model"]>;
type ModelMatch = Pick<ResolvedSubagentModel, "model" | "thinkingLevel">;

/**
 * Mirrors Pi CLI's single-model resolution against the already-authenticated
 * session catalogue: exact canonical/id matching first, then a partial
 * name/id match, with an optional `:thinking` suffix.
 */
function matchPiModelPattern(
  pattern: string,
  availableModels: AvailableModel[],
): ModelMatch | undefined {
  const exact = matchModel(pattern, availableModels);
  if (exact) return { model: exact };

  let candidates = availableModels;
  let modelPattern = pattern;
  const slashIndex = pattern.indexOf("/");
  if (slashIndex !== -1) {
    const provider = pattern.slice(0, slashIndex).toLowerCase();
    const providerModels = availableModels.filter(
      (model) => model.provider.toLowerCase() === provider,
    );
    if (providerModels.length > 0) {
      candidates = providerModels;
      modelPattern = pattern.slice(slashIndex + 1);
    }
  }

  const matched = matchModel(modelPattern, candidates);
  if (matched) return { model: matched };

  const lastColonIndex = modelPattern.lastIndexOf(":");
  if (lastColonIndex === -1) return undefined;
  const thinkingLevel = modelPattern.slice(lastColonIndex + 1);
  if (!THINKING_LEVELS.has(thinkingLevel)) return undefined;
  const withThinking = matchModel(
    modelPattern.slice(0, lastColonIndex),
    candidates,
  );
  return withThinking
    ? {
        model: withThinking,
        thinkingLevel: thinkingLevel as ModelMatch["thinkingLevel"],
      }
    : undefined;
}

function matchModel(
  pattern: string,
  availableModels: AvailableModel[],
): AvailableModel | undefined {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) return undefined;

  const exact = availableModels.filter(
    (model) =>
      model.id.toLowerCase() === normalized ||
      `${model.provider}/${model.id}`.toLowerCase() === normalized,
  );
  if (exact.length === 1) return exact[0];

  const partial = availableModels.filter(
    (model) =>
      model.id.toLowerCase().includes(normalized) ||
      model.name.toLowerCase().includes(normalized),
  );
  if (partial.length === 0) return undefined;

  const aliases = partial.filter((model) => !/-\d{8}$/.test(model.id));
  return (aliases.length > 0 ? aliases : partial).sort((a, b) =>
    b.id.localeCompare(a.id),
  )[0];
}

export function resolveSubagentModel(
  ctx: Pick<
    SubagentLaunchContext,
    "model" | "thinkingLevel" | "modelRegistry" | "scopedModels"
  >,
  kind: SubagentWorkstreamKind,
  configuredValue: string | undefined,
): ResolvedSubagentModel {
  const pattern = configuredValue?.trim() || "inherit";
  if (pattern === "inherit") {
    if (!ctx.model) {
      throw new Error(
        `Cannot inherit a ${kind} worker model because the parent has no active model.`,
      );
    }
    return {
      model: ctx.model,
      thinkingLevel: ctx.thinkingLevel,
      source: "inherit",
    };
  }

  const availableModels = ctx.modelRegistry.getAvailable();
  const candidates =
    ctx.scopedModels.length === 0
      ? availableModels
      : availableModels.filter((model) =>
          ctx.scopedModels.some(
            (scoped) =>
              scoped.model.provider === model.provider &&
              scoped.model.id === model.id,
          ),
        );
  const result = matchPiModelPattern(pattern, candidates);
  if (!result) {
    throw new Error(
      `Configured ${kind} worker model '${pattern}' is unavailable. Use "inherit" or an available Pi model pattern.`,
    );
  }

  return { ...result, source: "configured" };
}
