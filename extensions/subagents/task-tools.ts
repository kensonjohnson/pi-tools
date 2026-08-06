import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { TaskWorkstreamService } from "./task-workstreams.ts";

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
