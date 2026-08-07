import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ResearchWorkstreamService } from "./research-workstreams.ts";

const ResearchLaunchParameters = Type.Object({
  question: Type.String({
    description: "Focused research question to answer with cited evidence.",
    minLength: 1,
  }),
  scope: Type.String({
    description:
      "Requested sources, time range, exclusions, and desired depth; do not paste the parent transcript.",
    minLength: 1,
  }),
  linkedTaskWorkstreamId: Type.Optional(
    Type.String({
      description:
        "Optional existing task workstream that should receive only the finished cited synthesis while it remains live.",
      minLength: 1,
    }),
  ),
});

const ResearchReportParameters = Type.Object({
  workstreamId: Type.String({
    description: "Research workstream identifier to inspect.",
    minLength: 1,
  }),
});

const ResearchControlParameters = Type.Object({
  workstreamId: Type.String({
    description: "Research workstream identifier to control.",
    minLength: 1,
  }),
  action: Type.Union([
    Type.Literal("checkpoint"),
    Type.Literal("pause"),
    Type.Literal("cancel"),
    Type.Literal("resume"),
    Type.Literal("status"),
  ]),
  message: Type.Optional(
    Type.String({
      description:
        "Optional concise reason persisted for checkpoint, pause, or cancel.",
    }),
  ),
});

export function registerResearchWorkstreamTools(
  pi: ExtensionAPI,
  getService: () => ResearchWorkstreamService | undefined,
): void {
  pi.registerTool({
    name: "subagent_research_launch",
    label: "Launch research job",
    description:
      "Explicitly launch one fire-and-forget research job. It retains raw work locally and returns one concise cited synthesis when it completes or blocks.",
    parameters: ResearchLaunchParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const service = getService();
      if (!service) return unavailable();
      try {
        const workstream = await service.launch(ctx, params);
        return {
          content: [
            {
              type: "text",
              text: `Research job ${workstream.id} is running independently. Continue the parent task; it will provide one bounded cited synthesis when it completes or blocks.`,
            },
          ],
          details: {
            workstreamId: workstream.id,
            status: workstream.status,
            ...(workstream.linkedTaskWorkstreamId
              ? { linkedTaskWorkstreamId: workstream.linkedTaskWorkstreamId }
              : {}),
          },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  });

  pi.registerTool({
    name: "subagent_research_report",
    label: "Inspect research job",
    description:
      "Retrieve a bounded research synthesis and paths to its retained report and source index; raw research output remains local.",
    parameters: ResearchReportParameters,
    async execute(_toolCallId, params) {
      const service = getService();
      if (!service) return unavailable();
      try {
        const { manifest, report, sourceIndexArtifact } =
          await service.currentReport(params.workstreamId);
        return {
          content: [
            {
              type: "text",
              text: report
                ? formatReport(manifest.id, report, sourceIndexArtifact)
                : `Research job ${manifest.id} is ${manifest.status}; no synthesis has been retained yet.`,
            },
          ],
          details: {
            workstreamId: manifest.id,
            status: manifest.status,
            hasReport: Boolean(report),
            ...(sourceIndexArtifact ? { sourceIndexArtifact } : {}),
          },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  });

  pi.registerTool({
    name: "subagent_research_control",
    label: "Control research job",
    description:
      "Checkpoint, pause, cancel, explicitly resume, or inspect a fire-and-forget research job. Research jobs never restart automatically.",
    parameters: ResearchControlParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const service = getService();
      if (!service) return unavailable();
      try {
        const workstream = await service.control(ctx, params);
        return {
          content: [
            {
              type: "text",
              text: `Research job ${workstream.id}: ${params.action} recorded; status: ${workstream.status}.`,
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
}

function formatReport(
  id: string,
  report: Awaited<
    ReturnType<ResearchWorkstreamService["currentReport"]>
  >["report"],
  sourceIndexArtifact: string | undefined,
): string {
  if (!report) return `Research job ${id} has no retained report.`;
  return [
    `Research job ${id} ${report.status}.`,
    `Synthesis: ${report.synthesis}`,
    ...(report.citations.length
      ? report.citations.map(
          (citation) => `Source: ${citation.title} — ${citation.url}`,
        )
      : ["Sources: none retained."]),
    ...(report.blocker ? [`Blocker: ${report.blocker}`] : []),
    `Next action: ${report.nextAction}`,
    ...(sourceIndexArtifact ? [`Source index: ${sourceIndexArtifact}`] : []),
  ].join("\n");
}

function unavailable() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Research jobs are unavailable because this session is not a trusted, enabled subagent session.",
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
