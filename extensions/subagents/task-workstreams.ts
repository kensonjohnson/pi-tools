import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  EntryRenderer,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { resolveSubagentLaunchPolicy } from "./launch-policy.ts";
import {
  type WorkstreamCompletion,
  type WorkstreamManifest,
  WorkstreamSupervisor,
} from "./supervisor.ts";

export const TASK_TIMELINE_ENTRY_TYPE = "pi-tools:subagent-task-timeline";
export const TASK_HANDOFF_MESSAGE_TYPE = "pi-tools:subagent-task-handoff";
const MAX_HANDOFF_CHARS = 2_400;
const MAX_TIMELINE_LINES = 80;

type TaskReportStatus = "completed" | "blocked" | "needs-decision";

export type TaskWorkerReport = {
  version: 1;
  workstreamId: string;
  sequence: number;
  status: TaskReportStatus;
  outcome: string;
  files: string[];
  verification: string[];
  git: WorkstreamManifest["git"];
  nextAction: string;
  blocker?: string;
  finalAssistantText: string;
  capturedAt: string;
};

export type TaskTimelineEntry = {
  workstreamId: string;
  status: TaskReportStatus;
  outcome: string;
  artifact: string;
  timeline: string[];
};

export type TaskLaunchInput = {
  objective: string;
  scope: string;
  context?: string;
};

export type TaskFollowUpInput = {
  workstreamId: string;
  focus: string;
};

export class TaskWorkstreamService {
  private readonly pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">;
  private readonly supervisor: WorkstreamSupervisor;
  private readonly cwd: string;

  constructor(
    pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">,
    supervisor: WorkstreamSupervisor,
    cwd: string,
  ) {
    this.pi = pi;
    this.supervisor = supervisor;
    this.cwd = cwd;
    supervisor.setCompletionHandler((input) => this.handleCompletion(input));
  }

  async launch(
    ctx: ExtensionContext,
    input: TaskLaunchInput,
  ): Promise<WorkstreamManifest> {
    const policy = await resolveSubagentLaunchPolicy(ctx, "task");
    const manifest = await this.supervisor.launch({
      kind: "task",
      brief: buildTaskBrief(input),
      policy,
    });
    return manifest;
  }

  async followUp(input: TaskFollowUpInput): Promise<WorkstreamManifest> {
    const manifest = await this.requireTask(input.workstreamId);
    return this.supervisor.followUp(
      manifest.id,
      buildFocusedFollowUp(input.focus),
    );
  }

  async currentReport(workstreamId: string): Promise<{
    manifest: WorkstreamManifest;
    report?: TaskWorkerReport;
  }> {
    const manifest = await this.requireTask(workstreamId);
    return { manifest, report: await this.readLatestReport(manifest) };
  }

  async refreshWidget(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
    const manifests = (await this.supervisor.list()).filter(
      (entry) => entry.kind === "task",
    );
    const rows = manifests
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((entry) => formatWidgetRow(entry));
    ctx.ui.setWidget("pi-tools-subagent-workstreams", (_tui, theme) => ({
      render: (width) => [
        theme.fg("accent", "Task workstreams"),
        ...(rows.length > 0
          ? rows.map((row) => truncateToWidth(row, width))
          : [theme.fg("dim", "No task workstreams.")]),
      ],
      invalidate: () => {},
    }));
  }

  clearWidget(ctx: Pick<ExtensionContext, "ui">): void {
    ctx.ui.setWidget("pi-tools-subagent-workstreams", undefined);
  }

  private async handleCompletion(input: {
    manifest: WorkstreamManifest;
    session: { messages: AgentMessage[] };
  }): Promise<WorkstreamCompletion> {
    if (input.manifest.kind !== "task") return {};
    const finalAssistantText = extractFinalAssistantText(
      input.session.messages,
    );
    const report = normalizeTaskReport(
      parseTaskReport(finalAssistantText),
      input.manifest,
      finalAssistantText,
    );
    const artifact = await this.writeReport(input.manifest, report);
    const timeline = await this.readTimeline(input.manifest);
    const artifactReference = relative(this.cwd, artifact);

    // This entry is deliberately non-context session state. It gives people a
    // chronological inspection surface without making detailed worker history
    // part of the parent model's prompt.
    this.pi.appendEntry<TaskTimelineEntry>(TASK_TIMELINE_ENTRY_TYPE, {
      workstreamId: input.manifest.id,
      status: report.status,
      outcome: report.outcome,
      artifact: artifactReference,
      timeline,
    });
    this.pi.sendMessage(
      {
        customType: TASK_HANDOFF_MESSAGE_TYPE,
        content: formatBoundedHandoff(report, artifactReference),
        display: true,
        details: {
          workstreamId: input.manifest.id,
          artifact: artifactReference,
          status: report.status,
        },
      },
      { triggerTurn: true },
    );

    return {
      status:
        report.status === "blocked"
          ? "blocked"
          : report.status === "needs-decision"
            ? "needs_decision"
            : "settled",
      detail: report.blocker ?? report.outcome,
    };
  }

  private async requireTask(id: string): Promise<WorkstreamManifest> {
    const manifest = await this.supervisor.get(id);
    if (!manifest || manifest.kind !== "task") {
      throw new Error(`Unknown task workstream '${id}'.`);
    }
    return manifest;
  }

  private workstreamDirectory(manifest: WorkstreamManifest): string {
    return dirname(manifest.workerSessionDirectory);
  }

  private reportsDirectory(manifest: WorkstreamManifest): string {
    return join(this.workstreamDirectory(manifest), "reports");
  }

  private async writeReport(
    manifest: WorkstreamManifest,
    report: Omit<TaskWorkerReport, "sequence">,
  ): Promise<string> {
    const directory = this.reportsDirectory(manifest);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const existing = await this.readLatestReport(manifest);
    const sequence = (existing?.sequence ?? 0) + 1;
    const complete: TaskWorkerReport = { ...report, sequence };
    const path = join(directory, `${String(sequence).padStart(4, "0")}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(complete, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
    return path;
  }

  private async readLatestReport(
    manifest: WorkstreamManifest,
  ): Promise<TaskWorkerReport | undefined> {
    let names: string[];
    try {
      names = await readdir(this.reportsDirectory(manifest));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const name = names
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .at(-1);
    if (!name) return undefined;
    try {
      return JSON.parse(
        await readFile(join(this.reportsDirectory(manifest), name), "utf8"),
      ) as TaskWorkerReport;
    } catch {
      return undefined;
    }
  }

  private async readTimeline(manifest: WorkstreamManifest): Promise<string[]> {
    try {
      const journal = await readFile(
        join(this.workstreamDirectory(manifest), "journal.md"),
        "utf8",
      );
      return journal
        .split("\n")
        .filter((line) => line.startsWith("["))
        .slice(-MAX_TIMELINE_LINES);
    } catch {
      return [];
    }
  }
}

export function buildTaskBrief(input: TaskLaunchInput): string {
  return [
    "# Task-worker brief",
    "",
    "## Objective",
    input.objective.trim(),
    "",
    "## Scope and boundaries",
    input.scope.trim(),
    ...(input.context?.trim()
      ? ["", "## Relevant context", input.context.trim()]
      : []),
    "",
    "Work directly in the local repository as appropriate. Keep terse checkpoints in your response. If you are blocked or need a parent decision, stop rather than guessing or performing a consequential external action.",
    "",
    "End every run with exactly one `<task-worker-report>` JSON block and no prose after it:",
    "```json",
    '{"status":"completed|blocked|needs-decision","outcome":"concise outcome","files":["path"],"verification":["command or check: result"],"nextAction":"what the parent should do next","blocker":"required for blocked or needs-decision"}',
    "```",
    "The parent agent will retain the full response locally and receive only a bounded handoff.",
  ].join("\n");
}

export function buildFocusedFollowUp(focus: string): string {
  return [
    "# Focused parent follow-up",
    focus.trim(),
    "",
    "Continue using your existing task context. Do not restate the parent transcript. End with the required `<task-worker-report>` JSON block.",
  ].join("\n");
}

export const renderTaskTimelineEntry: EntryRenderer<TaskTimelineEntry> = (
  entry,
  options,
  theme,
) => {
  const data = entry.data;
  if (!isTimelineEntry(data)) return undefined;
  const heading = theme.fg(
    data.status === "completed" ? "success" : "warning",
    `Task ${shortId(data.workstreamId)} · ${data.status}`,
  );
  const compact = `${heading}\n${theme.fg("muted", bound(data.outcome, 500))}\n${theme.fg("dim", `Artifact: ${data.artifact} (full result collapsed)`)}`;
  if (!options.expanded) return new Text(compact, 0, 0);
  return new Text(
    [
      compact,
      "",
      theme.fg("accent", "Timeline"),
      ...(data.timeline.length > 0
        ? data.timeline.map((line) => theme.fg("dim", line))
        : [theme.fg("dim", "No recorded timeline events.")]),
    ].join("\n"),
    0,
    0,
  );
};

function parseTaskReport(text: string): Record<string, unknown> | undefined {
  const tagged = text.match(
    /<task-worker-report>\s*([\s\S]*?)\s*<\/task-worker-report>/i,
  )?.[1];
  const fenced =
    tagged?.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? tagged;
  if (!fenced) return undefined;
  try {
    const parsed = JSON.parse(fenced) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTaskReport(
  parsed: Record<string, unknown> | undefined,
  manifest: WorkstreamManifest,
  finalAssistantText: string,
): Omit<TaskWorkerReport, "sequence"> {
  const status =
    parsed?.status === "blocked" || parsed?.status === "needs-decision"
      ? parsed.status
      : "completed";
  const blocker = textField(parsed?.blocker, 700);
  return {
    version: 1,
    workstreamId: manifest.id,
    status,
    outcome:
      textField(parsed?.outcome, 1_000) ||
      bound(finalAssistantText, 1_000) ||
      "Worker settled without a text report.",
    files: stringList(parsed?.files, 30, 240),
    verification: stringList(parsed?.verification, 20, 300),
    git: manifest.git,
    nextAction:
      textField(parsed?.nextAction, 700) ||
      "Review the retained worker artifact.",
    ...(blocker ? { blocker } : {}),
    finalAssistantText,
    capturedAt: new Date().toISOString(),
  };
}

function extractFinalAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function formatBoundedHandoff(
  report: TaskWorkerReport,
  artifact: string,
): string {
  const label =
    report.status === "completed"
      ? "completed"
      : report.status === "blocked"
        ? "is blocked"
        : "needs a decision";
  const lines = [
    `Task worker ${shortId(report.workstreamId)} ${label}.`,
    `Outcome: ${report.outcome}`,
    ...(report.files.length ? [`Files: ${report.files.join(", ")}`] : []),
    ...(report.verification.length
      ? [`Verification: ${report.verification.join("; ")}`]
      : []),
    ...(report.git.branch || report.git.commit
      ? [
          `Git observed: ${report.git.branch ?? "detached"}${report.git.commit ? ` @ ${report.git.commit}` : ""}`,
        ]
      : []),
    ...(report.blocker ? [`Blocker: ${report.blocker}`] : []),
    `Next action: ${report.nextAction}`,
    `Full worker result: ${artifact}`,
  ];
  return bound(lines.join("\n"), MAX_HANDOFF_CHARS);
}

function formatWidgetRow(manifest: WorkstreamManifest): string {
  const indicator =
    manifest.status === "running" || manifest.status === "starting"
      ? "●"
      : manifest.status === "settled"
        ? "✓"
        : "!";
  return `${indicator} ${shortId(manifest.id)}  ${manifest.status}  ${bound(firstLine(manifest.brief), 72)}`;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "Task worker"
  );
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function textField(value: unknown, limit: number): string {
  return typeof value === "string" ? bound(value, limit) : "";
}

function stringList(
  value: unknown,
  maximum: number,
  itemLimit: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => bound(entry, itemLimit))
    .filter(Boolean)
    .slice(0, maximum);
}

function bound(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1)}…`;
}

function isTimelineEntry(value: unknown): value is TaskTimelineEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "workstreamId" in value &&
    "timeline" in value
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
