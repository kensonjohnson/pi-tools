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
import {
  renderResearchTimelineEntry,
  ResearchWorkstreamService,
} from "./research-workstreams.ts";
import { registerResearchWorkstreamTools } from "./research-tools.ts";
import {
  renderTaskControlTimelineEntry,
  renderTaskTimelineEntry,
  TaskWorkstreamService,
} from "./task-workstreams.ts";
import { registerTaskWorkstreamTools } from "./task-tools.ts";
import { WorkstreamSupervisor } from "./supervisor.ts";

export default function (pi: ExtensionAPI) {
  let supervisor: WorkstreamSupervisor | undefined;
  let tasks: TaskWorkstreamService | undefined;
  let research: ResearchWorkstreamService | undefined;

  publishExtensionSettings(pi.events, SUBAGENT_SETTINGS);
  registerTaskWorkstreamTools(pi, () => tasks);
  registerResearchWorkstreamTools(pi, () => research);
  pi.registerEntryRenderer(
    "pi-tools:subagent-task-timeline",
    renderTaskTimelineEntry,
  );
  pi.registerEntryRenderer(
    "pi-tools:subagent-task-control-timeline",
    renderTaskControlTimelineEntry,
  );
  pi.registerEntryRenderer(
    "pi-tools:subagent-research-timeline",
    renderResearchTimelineEntry,
  );

  pi.on("session_start", async (_event, ctx) => {
    const enabled =
      ctx.isProjectTrusted() &&
      (await isExtensionEnabled(ctx, CONFIG_DIR_NAME, SUBAGENTS_EXTENSION_ID));
    removeDisabledTools(pi, SUBAGENT_TOOL_NAMES, enabled);
    supervisor = undefined;
    tasks = undefined;
    research = undefined;
    if (!enabled) return;

    supervisor = new WorkstreamSupervisor({
      cwd: ctx.cwd,
      onEvent: () => {
        // Routine state remains in the widget and durable journal; only task
        // completion policy may send a bounded main-agent handoff.
        void tasks?.refreshWidget(ctx);
      },
    });
    tasks = new TaskWorkstreamService(pi, supervisor, ctx.cwd);
    research = new ResearchWorkstreamService(pi, supervisor, tasks, ctx.cwd);
    await supervisor.recoverInterrupted();
    await tasks.refreshWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await supervisor?.shutdown();
    tasks?.clearWidget(ctx);
    supervisor = undefined;
    tasks = undefined;
    research = undefined;
  });
}
