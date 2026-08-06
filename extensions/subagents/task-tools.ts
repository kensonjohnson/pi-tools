import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { TaskWorkstreamService } from "./task-workstreams.ts";

const MAX_TASK_LAUNCH_TITLE_CHARS = 160;

const TaskLaunchParameters = Type.Object({
  objective: Type.String({
    description: "Specific outcome the worker should achieve.",
    minLength: 1,
  }),
  scope: Type.String({
    description:
      "Explicit files, subsystem boundaries, constraints, and acceptance focus; do not paste the parent transcript.",
    minLength: 1,
  }),
  context: Type.Optional(
    Type.String({
      description:
        "Small, directly relevant facts or decisions the worker needs; omit unrelated conversation history.",
    }),
  ),
});

const TaskFollowUpParameters = Type.Object({
  workstreamId: Type.String({
    description:
      "The task workstream identifier returned by subagent_task_launch.",
    minLength: 1,
  }),
  focus: Type.String({
    description:
      "A focused next question or instruction for this same worker; it retains its detailed context.",
    minLength: 1,
  }),
});

const TaskReportParameters = Type.Object({
  workstreamId: Type.String({
    description: "The task workstream identifier to inspect.",
    minLength: 1,
  }),
});

const TaskControlParameters = Type.Object({
  workstreamId: Type.String({
    description: "The task workstream identifier to control.",
    minLength: 1,
  }),
  action: Type.Union(
    [
      Type.Literal("redirect"),
      Type.Literal("checkpoint"),
      Type.Literal("pause"),
      Type.Literal("cancel"),
      Type.Literal("resume"),
      Type.Literal("status"),
    ],
    {
      description:
        "redirect steers current work; checkpoint snapshots recovery context; pause stops resumably; cancel is terminal; resume explicitly reopens a paused worker; status inspects state.",
    },
  ),
  message: Type.Optional(
    Type.String({
      description:
        "Required for redirect; optional concise reason for checkpoint, pause, or cancel. It is saved in the durable journal.",
    }),
  ),
});

export function registerTaskWorkstreamTools(
  pi: ExtensionAPI,
  getService: () => TaskWorkstreamService | undefined,
): void {
  pi.registerTool({
    name: "subagent_task_launch",
    label: "Launch task worker",
    description:
      "Explicitly launch one persistent task worker with a focused objective, scope, and minimal relevant context. The worker runs independently; do not delegate routine work merely because capacity exists.",
    parameters: TaskLaunchParameters,
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", `Task: ${taskLaunchTitle(args.objective)}`),
        0,
        0,
      );
    },
    renderResult(_result, _options, theme, context) {
      return new Text(
        theme.fg("success", `Task: ${taskLaunchTitle(context.args.objective)}`),
        0,
        0,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const service = getService();
      if (!service) return unavailable();
      try {
        const workstream = await service.launch(ctx, params);
        await service.refreshWidget(ctx);
        return {
          content: [
            {
              type: "text",
              text: `Task worker ${workstream.id} is running independently. Continue the parent task; it will provide a bounded handoff when it completes, blocks, or needs a decision.`,
            },
          ],
          details: { workstreamId: workstream.id, status: workstream.status },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  });

  pi.registerTool({
    name: "subagent_task_follow_up",
    label: "Follow up with task worker",
    description:
      "Send a focused follow-up to a persistent task worker without importing its transcript into the parent context.",
    parameters: TaskFollowUpParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const service = getService();
      if (!service) return unavailable();
      try {
        const workstream = await service.followUp(params);
        await service.refreshWidget(ctx);
        return {
          content: [
            {
              type: "text",
              text: `Focused follow-up sent to task worker ${workstream.id}; status: ${workstream.status}.`,
            },
          ],
          details: { workstreamId: workstream.id, status: workstream.status },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  });

  pi.registerTool({
    name: "subagent_task_control",
    label: "Control task worker",
    description:
      "Perform a deliberate task-worker lifecycle action. Redirect uses the live steer queue; pause and cancel never restart work automatically; only an explicit resume may reopen a paused worker.",
    parameters: TaskControlParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const service = getService();
      if (!service) return unavailable();
      try {
        const workstream = await service.control(ctx, params);
        await service.refreshWidget(ctx);
        return {
          content: [
            {
              type: "text",
              text: formatControlResult(
                workstream.id,
                params.action,
                workstream.status,
              ),
            },
          ],
          details: {
            workstreamId: workstream.id,
            action: params.action,
            status: workstream.status,
          },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  });

  pi.registerTool({
    name: "subagent_task_report",
    label: "Inspect task worker report",
    description:
      "Retrieve the latest bounded report for a task worker. Detailed transcript and raw output remain in its local artifact.",
    parameters: TaskReportParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const service = getService();
      if (!service) return unavailable();
      try {
        const { manifest, report } = await service.currentReport(
          params.workstreamId,
        );
        await service.refreshWidget(ctx);
        return {
          content: [
            {
              type: "text",
              text: report
                ? formatReport(manifest.id, report)
                : `Task worker ${manifest.id} is ${manifest.status}; no completed worker report has been retained yet.`,
            },
          ],
          details: {
            workstreamId: manifest.id,
            status: manifest.status,
            hasReport: Boolean(report),
          },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  });
}

function taskLaunchTitle(objective: string): string {
  const normalized = objective.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_TASK_LAUNCH_TITLE_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_TASK_LAUNCH_TITLE_CHARS - 1)}…`;
}

function formatControlResult(
  id: string,
  action: string,
  status: string,
): string {
  return `Task worker ${id}: ${action} recorded; status: ${status}.`;
}

function formatReport(
  id: string,
  report: Awaited<ReturnType<TaskWorkstreamService["currentReport"]>>["report"],
): string {
  if (!report) return `Task worker ${id} has no retained report.`;
  return [
    `Task worker ${id} ${report.status}.`,
    `Outcome: ${report.outcome}`,
    ...(report.files.length ? [`Files: ${report.files.join(", ")}`] : []),
    ...(report.verification.length
      ? [`Verification: ${report.verification.join("; ")}`]
      : []),
    ...(report.blocker ? [`Blocker: ${report.blocker}`] : []),
    `Next action: ${report.nextAction}`,
  ].join("\n");
}

function unavailable() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Task workers are unavailable because this session is not a trusted, enabled subagent session.",
      },
    ],
    isError: true,
    details: {},
  };
}

function toolError(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
    details: {},
  };
}
