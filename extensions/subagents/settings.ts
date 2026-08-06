import type { ExtensionSettingsDefinition } from "../../lib/pi-tools-config.ts";

export const SUBAGENTS_EXTENSION_ID = "subagents";

// The supervisor and workstream tickets register these tools. Keeping the
// complete list here lets the enabled setting consistently hide them all.
export const SUBAGENT_TOOL_NAMES = [
  "subagent_task_launch",
  "subagent_task_follow_up",
  "subagent_task_report",
  "subagent_task_control",
  "subagent_research_launch",
  "subagent_workstreams",
] as const;

export type SubagentWorkstreamKind = "task" | "research";

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
    maxConcurrentWorkers: {
      type: "number",
      default: 2,
      minimum: 1,
      integer: true,
      label: "Maximum concurrent workers",
      description:
        "Combined cap across task workers and research jobs; launches above it are refused.",
    },
    "models.task": {
      type: "string",
      default: "inherit",
      label: "Task-worker model",
      description:
        'Use "inherit" for the current parent model, or a Pi model pattern.',
    },
    "models.research": {
      type: "string",
      default: "inherit",
      label: "Research-job model",
      description:
        'Use "inherit" for the current parent model, or a Pi model pattern.',
    },
  },
  toolNames: SUBAGENT_TOOL_NAMES,
};

export function modelFieldForWorkstream(
  kind: SubagentWorkstreamKind,
): "models.task" | "models.research" {
  return kind === "task" ? "models.task" : "models.research";
}
