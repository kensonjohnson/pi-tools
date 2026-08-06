import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  EntryRenderer,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Text,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { resolveSubagentLaunchPolicy } from "./launch-policy.ts";
import { CompletionInbox } from "./completion-inbox.ts";
import {
  type WorkstreamCompletion,
  type WorkstreamManifest,
  WorkstreamSupervisor,
} from "./supervisor.ts";

export const TASK_TIMELINE_ENTRY_TYPE = "pi-tools:subagent-task-timeline";
export const TASK_CONTROL_TIMELINE_ENTRY_TYPE =
  "pi-tools:subagent-task-control-timeline";
export const TASK_HANDOFF_MESSAGE_TYPE = "pi-tools:subagent-task-handoff";
const MAX_HANDOFF_CHARS = 2_400;
const MAX_TIMELINE_LINES = 80;
const WIDGET_ACTIVE_STATUSES = new Set<WorkstreamManifest["status"]>([
  "starting",
  "running",
  "paused",
  "blocked",
  "needs_decision",
]);
const WORKSTREAM_SPINNER_INTERVAL_MS = 80;
const WORKSTREAM_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

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

export type TaskControlTimelineEntry = {
  workstreamId: string;
  action: Exclude<TaskControlAction, "status">;
  status: WorkstreamManifest["status"];
  detail?: string;
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

export type TaskControlAction =
  "redirect" | "checkpoint" | "pause" | "cancel" | "resume" | "status";

export type TaskControlInput = {
  workstreamId: string;
  action: TaskControlAction;
  message?: string;
};

export class TaskWorkstreamService {
  private readonly pi: Pick<ExtensionAPI, "appendEntry">;
  private readonly supervisor: WorkstreamSupervisor;
  private readonly cwd: string;
  private readonly inbox: CompletionInbox;

  constructor(
    pi: Pick<ExtensionAPI, "appendEntry">,
    supervisor: WorkstreamSupervisor,
    cwd: string,
    inbox = new CompletionInbox(supervisor.rootDirectory),
  ) {
    this.pi = pi;
    this.supervisor = supervisor;
    this.cwd = cwd;
    this.inbox = inbox;
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

  async deliverResearchSynthesis(
    workstreamId: string,
    synthesis: string,
  ): Promise<boolean> {
    const manifest = await this.requireTask(workstreamId);
    // A research job may only inform the worker the parent explicitly linked
    // while it is still live; it must never restart or reopen task work.
    if (
      manifest.status !== "running" ||
      !(await this.supervisor.isLive(manifest.id))
    ) {
      return false;
    }
    try {
      await this.supervisor.followUp(
        manifest.id,
        buildResearchSynthesisFollowUp(synthesis),
      );
      return true;
    } catch {
      return false;
    }
  }

  async currentReport(workstreamId: string): Promise<{
    manifest: WorkstreamManifest;
    report?: TaskWorkerReport;
  }> {
    const manifest = await this.requireTask(workstreamId);
    return { manifest, report: await this.readLatestReport(manifest) };
  }

  async control(
    ctx: ExtensionContext,
    input: TaskControlInput,
  ): Promise<WorkstreamManifest> {
    const manifest = await this.requireTask(input.workstreamId);
    const message = input.message?.trim();
    if (input.action === "status") return manifest;

    let next: WorkstreamManifest;
    switch (input.action) {
      case "redirect":
        if (!message) throw new Error("A redirect instruction is required.");
        next = await this.supervisor.redirect(
          manifest.id,
          buildRedirect(message),
        );
        break;
      case "checkpoint":
        next = await this.supervisor.checkpoint(manifest.id, message);
        break;
      case "pause":
        next = await this.supervisor.pause(manifest.id, message);
        break;
      case "cancel":
        next = await this.supervisor.cancel(manifest.id, message);
        break;
      case "resume": {
        const policy = await resolveSubagentLaunchPolicy(ctx, "task");
        next = await this.supervisor.resume(manifest.id, policy);
        break;
      }
    }
    this.pi.appendEntry<TaskControlTimelineEntry>(
      TASK_CONTROL_TIMELINE_ENTRY_TYPE,
      {
        workstreamId: next.id,
        action: input.action,
        status: next.status,
        ...(message ? { detail: bound(message, 500) } : {}),
      },
    );
    return next;
  }

  async refreshWidget(ctx: Pick<ExtensionContext, "ui">): Promise<void> {
    const inboxRecords = await this.inbox.listUnconsumed();
    const inboxByWorkstream = new Map(
      inboxRecords.map((record) => [record.workstreamId, record.deliveryState]),
    );
    const manifests = (await this.supervisor.list())
      .filter(
        (entry) =>
          WIDGET_ACTIVE_STATUSES.has(entry.status) ||
          inboxByWorkstream.has(entry.id),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (manifests.length === 0) {
      this.clearWidget(ctx);
      return;
    }
    const rows = manifests.map((entry) =>
      formatWidgetRow(entry, inboxByWorkstream.get(entry.id)),
    );
    ctx.ui.setWidget(
      "pi-tools-subagent-workstreams",
      (tui, theme) => new WorkstreamsWidget(tui, theme, rows),
    );
  }

  clearWidget(ctx: Pick<ExtensionContext, "ui">): void {
    ctx.ui.setWidget("pi-tools-subagent-workstreams", undefined);
  }

  private async handleCompletion(input: {
    manifest: WorkstreamManifest;
    session: { messages: AgentMessage[] };
  }): Promise<WorkstreamCompletion> {
    if (input.manifest.kind !== "task") return undefined;
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
    await this.inbox.create({
      workstreamId: input.manifest.id,
      kind: input.manifest.kind,
      terminalStatus:
        report.status === "blocked"
          ? "blocked"
          : report.status === "needs-decision"
            ? "needs_decision"
            : "settled",
      handoff: formatBoundedHandoff(report, artifactReference),
      artifactReferences: [artifactReference],
      sourceCustomType: TASK_HANDOFF_MESSAGE_TYPE,
      sourceDetails: {
        workstreamId: input.manifest.id,
        artifact: artifactReference,
        status: report.status,
      },
    });

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

export function buildResearchSynthesisFollowUp(synthesis: string): string {
  return [
    "# Linked research synthesis",
    bound(synthesis, 2_400),
    "",
    "Use this cited synthesis only if it helps the active task. Do not request or import the research worker's transcript or raw sources. Continue your existing task and end the run with the required `<task-worker-report>` JSON block.",
  ].join("\n");
}

export function buildRedirect(instruction: string): string {
  return [
    "# Parent redirect",
    instruction.trim(),
    "",
    "Treat this as the current priority. Keep the existing worker context, stop work that no longer serves this direction, and end with the required `<task-worker-report>` JSON block when the run concludes.",
  ].join("\n");
}

export const renderTaskControlTimelineEntry: EntryRenderer<
  TaskControlTimelineEntry
> = (entry, _options, theme) => {
  const data = entry.data;
  if (!isControlTimelineEntry(data)) return undefined;
  return new Text(
    [
      theme.fg(
        data.action === "cancel" ? "warning" : "accent",
        `Task ${shortId(data.workstreamId)} · ${data.action} · ${data.status}`,
      ),
      ...(data.detail ? [theme.fg("dim", data.detail)] : []),
    ].join("\n"),
    0,
    0,
  );
};

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

export type WorkstreamWidgetRow = {
  text: string;
  status: WorkstreamManifest["status"];
};

type WorkstreamWidgetScheduler = {
  setInterval(
    callback: () => void,
    milliseconds: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
};

const systemWidgetScheduler: WorkstreamWidgetScheduler = {
  setInterval,
  clearInterval,
};

export class WorkstreamsWidget implements Component {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly tui: Pick<TUI, "requestRender">;
  private readonly theme: { fg(color: string, text: string): string };
  private readonly rows: WorkstreamWidgetRow[];
  private readonly scheduler: WorkstreamWidgetScheduler;

  constructor(
    tui: Pick<TUI, "requestRender">,
    theme: { fg(color: string, text: string): string },
    rows: WorkstreamWidgetRow[],
    scheduler: WorkstreamWidgetScheduler = systemWidgetScheduler,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.rows = rows;
    this.scheduler = scheduler;
    if (rows.some((row) => row.status === "running")) {
      this.timer = scheduler.setInterval(() => {
        this.frame = (this.frame + 1) % WORKSTREAM_SPINNER_FRAMES.length;
        this.tui.requestRender();
      }, WORKSTREAM_SPINNER_INTERVAL_MS);
    }
  }

  render(width: number): string[] {
    return [
      this.theme.fg("accent", "Subagent workstreams"),
      ...this.rows.map((row) =>
        truncateToWidth(
          row.status === "running"
            ? `${WORKSTREAM_SPINNER_FRAMES[this.frame]} ${row.text}`
            : row.text,
          width,
        ),
      ),
    ];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.timer === undefined) return;
    this.scheduler.clearInterval(this.timer);
    this.timer = undefined;
  }
}

function formatWidgetRow(
  manifest: WorkstreamManifest,
  inboxState: "pending" | "scheduled" | undefined,
): WorkstreamWidgetRow {
  const inbox =
    inboxState === "pending"
      ? " · inbox pending"
      : inboxState === "scheduled"
        ? " · inbox queued"
        : "";
  return {
    text: `${manifest.kind} ${shortId(manifest.id)} · ${workstreamPurpose(manifest)} · ${manifest.status}${inbox}`,
    status: manifest.status,
  };
}

function workstreamPurpose(manifest: WorkstreamManifest): string {
  const marker =
    manifest.kind === "research" ? "## Focused question\n" : "## Objective\n";
  const afterMarker = manifest.brief.split(marker)[1];
  const purpose = afterMarker?.split("\n")[0] ?? manifest.brief;
  return bound(purpose, 160) || "Purpose retained in worker brief.";
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

function isControlTimelineEntry(
  value: unknown,
): value is TaskControlTimelineEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "workstreamId" in value &&
    "action" in value &&
    "status" in value
  );
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
