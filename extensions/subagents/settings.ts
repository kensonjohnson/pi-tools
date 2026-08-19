import type {
  ExtensionSettingsDefinition,
  SettingsSelectContext,
} from "../../lib/pi-tools-config.ts";

export const SUBAGENTS_EXTENSION_ID = "subagents";

// The supervisor and workstream tickets register these tools. Keeping the
// complete list here lets the enabled setting consistently hide them all.
export const SUBAGENT_TOOL_NAMES = [
  "subagent_task_launch",
  "subagent_task_follow_up",
  "subagent_task_report",
  "subagent_task_control",
  "subagent_research_launch",
  "subagent_research_report",
  "subagent_research_control",
  "subagent_wait",
] as const;

export type SubagentWorkstreamKind = "task" | "research";
export type SubagentDelegationMode = "manual" | "proactive";

/**
 * Returns Pi model picker values for this session. Scoped models preserve their
 * pinned thinking level; an unscoped session can choose any available model.
 */
export function scopedModelSelectionValues(
  context: SettingsSelectContext,
): readonly string[] {
  const values =
    context.scopedModels.length > 0
      ? context.scopedModels.map(({ model, thinkingLevel }) =>
          thinkingLevel
            ? `${model.provider}/${model.id}:${thinkingLevel}`
            : `${model.provider}/${model.id}`,
        )
      : context.modelRegistry
          .getAvailable()
          .map((model) => `${model.provider}/${model.id}`);
  return ["inherit", ...new Set(values)];
}

export const SUBAGENT_SETTINGS: ExtensionSettingsDefinition = {
  id: SUBAGENTS_EXTENSION_ID,
  label: "Subagents",
  description:
    "Controls explicit task-worker and research-job delegation. The concurrency limit is a ceiling, not a delegation target.",
  fields: {
    enabled: {
      type: "boolean",
      default: true,
      label: "Enabled",
      description: "Allows explicit task-worker and research-job launches.",
    },
    delegationMode: {
      type: "enum",
      default: "proactive",
      values: ["manual", "proactive"],
      label: "Delegation mode",
      description:
        "Proactive lets the main agent independently delegate useful bounded work; manual requires an explicit delegation request.",
    },
    maxConcurrentWorkers: {
      type: "number",
      default: 2,
      minimum: 1,
      integer: true,
      label: "Maximum concurrent workers",
      description:
        "Combined cap across task workers and research jobs; launches above it are refused.",
    },
    outputTailLines: {
      type: "number",
      default: 0,
      minimum: 0,
      integer: true,
      label: "Live output tail lines",
      description:
        "Shows this many newest concise thinking and tool lifecycle rows per live workstream; 0 hides them.",
    },
    "models.task": {
      type: "string",
      default: "inherit",
      label: "Task-worker model",
      description: 'Choose "inherit" or an available Pi model.',
      selectValues: scopedModelSelectionValues,
    },
    "models.research": {
      type: "string",
      default: "inherit",
      label: "Research-job model",
      description: 'Choose "inherit" or an available Pi model.',
      selectValues: scopedModelSelectionValues,
    },
  },
  toolNames: SUBAGENT_TOOL_NAMES,
};

export function modelFieldForWorkstream(
  kind: SubagentWorkstreamKind,
): "models.task" | "models.research" {
  return kind === "task" ? "models.task" : "models.research";
}
