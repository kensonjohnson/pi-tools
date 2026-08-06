import { relative } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
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
import { resolveSubagentDelegationMode } from "./launch-policy.ts";
import { WorkstreamSupervisor } from "./supervisor.ts";

const PROACTIVE_DELEGATION_GUIDANCE = `
## Proactive subagent delegation

Use the available subagent tools proactively during ordinary work: independently launch a task worker or research job when a clearly bounded, useful subproblem can proceed in parallel, such as repository investigation, external research, test reproduction, or a separable implementation slice. Do not wait for the user to request a worker and do not delegate merely because capacity exists.

Keep ownership of user intent, integration, consequential decisions, and acceptance. Give workers a narrow objective and scope, honor the shared concurrency cap, and use their bounded handoffs rather than importing detailed worker transcripts. Never delegate consequential external operations; stop and report those needs instead.
`.trim();

export default function (pi: ExtensionAPI) {
  let supervisor: WorkstreamSupervisor | undefined;
  let tasks: TaskWorkstreamService | undefined;
  let research: ResearchWorkstreamService | undefined;
  let delegationMode: "manual" | "proactive" = "manual";

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
    const workerSession = isSubagentWorkerSession(ctx);
    const enabled =
      !workerSession &&
      ctx.isProjectTrusted() &&
      (await isExtensionEnabled(ctx, CONFIG_DIR_NAME, SUBAGENTS_EXTENSION_ID));
    removeDisabledTools(pi, SUBAGENT_TOOL_NAMES, enabled);
    supervisor = undefined;
    tasks = undefined;
    research = undefined;
    delegationMode = "manual";
    if (!enabled) return;
    delegationMode = await resolveSubagentDelegationMode(ctx);

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

  pi.on("before_agent_start", async (event, ctx) => {
    if (
      delegationMode !== "proactive" ||
      !ctx.isProjectTrusted() ||
      isSubagentWorkerSession(ctx)
    ) {
      return;
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${PROACTIVE_DELEGATION_GUIDANCE}`,
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await supervisor?.shutdown();
    tasks?.clearWidget(ctx);
    supervisor = undefined;
    tasks = undefined;
    research = undefined;
    delegationMode = "manual";
  });
}

export function isSubagentWorkerSession(
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): boolean {
  const sessionDirectory = ctx.sessionManager?.getSessionDir?.();
  if (!sessionDirectory) return false;
  const subagentRoot = `${ctx.cwd}/tmp/subagents`;
  const path = relative(subagentRoot, sessionDirectory);
  return path === "session" || (!path.startsWith("..") && !path.includes(".."));
}

export { PROACTIVE_DELEGATION_GUIDANCE };
