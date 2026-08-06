import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  EntryRenderer,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveSubagentLaunchPolicy } from "./launch-policy.ts";
import {
  type WorkstreamCompletion,
  type WorkstreamManifest,
  WorkstreamSupervisor,
} from "./supervisor.ts";
import { TaskWorkstreamService } from "./task-workstreams.ts";

export const RESEARCH_TIMELINE_ENTRY_TYPE =
  "pi-tools:subagent-research-timeline";
export const RESEARCH_HANDOFF_MESSAGE_TYPE =
  "pi-tools:subagent-research-handoff";
const MAX_HANDOFF_CHARS = 2_400;

type ResearchReportStatus = "completed" | "blocked";

export type ResearchCitation = {
  url: string;
  title: string;
  note: string;
};

export type ResearchJobReport = {
  version: 1;
  workstreamId: string;
  sequence: number;
  status: ResearchReportStatus;
  question: string;
  synthesis: string;
  citations: ResearchCitation[];
  nextAction: string;
  blocker?: string;
  finalAssistantText: string;
  capturedAt: string;
};

export type ResearchTimelineEntry = {
  workstreamId: string;
  status: ResearchReportStatus;
  synthesis: string;
  citationCount: number;
  reportArtifact: string;
  sourceIndexArtifact: string;
};

export type ResearchLaunchInput = {
  question: string;
  scope: string;
  linkedTaskWorkstreamId?: string;
};

export type ResearchControlAction =
  "checkpoint" | "pause" | "cancel" | "resume" | "status";

export type ResearchControlInput = {
  workstreamId: string;
  action: ResearchControlAction;
  message?: string;
};

export class ResearchWorkstreamService {
  private readonly pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">;
  private readonly supervisor: WorkstreamSupervisor;
  private readonly tasks: TaskWorkstreamService;
  private readonly cwd: string;

  constructor(
    pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">,
    supervisor: WorkstreamSupervisor,
    tasks: TaskWorkstreamService,
    cwd: string,
  ) {
    this.pi = pi;
    this.supervisor = supervisor;
    this.tasks = tasks;
    this.cwd = cwd;
    supervisor.addCompletionHandler((input) => this.handleCompletion(input));
  }

  async launch(
    ctx: ExtensionContext,
    input: ResearchLaunchInput,
  ): Promise<WorkstreamManifest> {
    if (input.linkedTaskWorkstreamId?.trim()) {
      await this.tasks.currentReport(input.linkedTaskWorkstreamId.trim());
    }
    const policy = await resolveSubagentLaunchPolicy(ctx, "research");
    return this.supervisor.launch({
      kind: "research",
      brief: buildResearchBrief(input),
      linkedTaskWorkstreamId: input.linkedTaskWorkstreamId?.trim(),
      policy,
    });
  }

  async currentReport(workstreamId: string): Promise<{
    manifest: WorkstreamManifest;
    report?: ResearchJobReport;
    sourceIndexArtifact?: string;
  }> {
    const manifest = await this.requireResearch(workstreamId);
    const report = await this.readLatestReport(manifest);
    return {
      manifest,
      report,
      ...(report
        ? {
            sourceIndexArtifact: relative(
              this.cwd,
              this.sourceIndexPath(manifest, report.sequence),
            ),
          }
        : {}),
    };
  }

  async control(
    ctx: ExtensionContext,
    input: ResearchControlInput,
  ): Promise<WorkstreamManifest> {
    const manifest = await this.requireResearch(input.workstreamId);
    const message = input.message?.trim();
    switch (input.action) {
      case "checkpoint":
        return this.supervisor.checkpoint(manifest.id, message);
      case "pause":
        return this.supervisor.pause(manifest.id, message);
      case "cancel":
        return this.supervisor.cancel(manifest.id, message);
      case "resume": {
        const policy = await resolveSubagentLaunchPolicy(ctx, "research");
        return this.supervisor.resume(manifest.id, policy);
      }
      case "status":
        return manifest;
    }
  }

  private async handleCompletion(input: {
    manifest: WorkstreamManifest;
    session: { messages: AgentMessage[] };
  }): Promise<WorkstreamCompletion | undefined> {
    if (input.manifest.kind !== "research") return undefined;
    const finalAssistantText = extractFinalAssistantText(
      input.session.messages,
    );
    const report = normalizeResearchReport(
      parseResearchReport(finalAssistantText),
      input.manifest,
      finalAssistantText,
    );
    const reportArtifact = await this.writeReport(input.manifest, report);
    const sourceIndexArtifact = await this.writeSourceIndex(
      input.manifest,
      report,
    );
    const reportReference = relative(this.cwd, reportArtifact);
    const sourceReference = relative(this.cwd, sourceIndexArtifact);

    let delivery: "delivered" | "unavailable" | undefined;
    if (input.manifest.linkedTaskWorkstreamId) {
      const delivered = await this.tasks.deliverResearchSynthesis(
        input.manifest.linkedTaskWorkstreamId,
        formatLinkedSynthesis(report),
      );
      delivery = delivered ? "delivered" : "unavailable";
      await this.supervisor.recordDelivery(
        input.manifest.id,
        delivered
          ? `Cited synthesis delivered to linked task worker ${input.manifest.linkedTaskWorkstreamId}.`
          : `Linked task worker ${input.manifest.linkedTaskWorkstreamId} was not live; no synthesis was delivered.`,
      );
    }

    this.pi.appendEntry<ResearchTimelineEntry>(RESEARCH_TIMELINE_ENTRY_TYPE, {
      workstreamId: input.manifest.id,
      status: report.status,
      synthesis: report.synthesis,
      citationCount: report.citations.length,
      reportArtifact: reportReference,
      sourceIndexArtifact: sourceReference,
    });
    this.pi.sendMessage(
      {
        customType: RESEARCH_HANDOFF_MESSAGE_TYPE,
        content: formatBoundedHandoff(
          report,
          reportReference,
          sourceReference,
          input.manifest.linkedTaskWorkstreamId,
          delivery,
        ),
        display: true,
        details: {
          workstreamId: input.manifest.id,
          reportArtifact: reportReference,
          sourceIndexArtifact: sourceReference,
          ...(input.manifest.linkedTaskWorkstreamId
            ? {
                linkedTaskWorkstreamId: input.manifest.linkedTaskWorkstreamId,
                delivery,
              }
            : {}),
        },
      },
      { triggerTurn: true },
    );

    return {
      status: report.status === "blocked" ? "blocked" : "settled",
      detail: report.blocker ?? report.synthesis,
    };
  }

  private async requireResearch(id: string): Promise<WorkstreamManifest> {
    const manifest = await this.supervisor.get(id);
    if (!manifest || manifest.kind !== "research") {
      throw new Error(`Unknown research workstream '${id}'.`);
    }
    return manifest;
  }

  private workstreamDirectory(manifest: WorkstreamManifest): string {
    return dirname(manifest.workerSessionDirectory);
  }

  private reportsDirectory(manifest: WorkstreamManifest): string {
    return join(this.workstreamDirectory(manifest), "reports");
  }

  private sourcesDirectory(manifest: WorkstreamManifest): string {
    return join(this.workstreamDirectory(manifest), "sources");
  }

  private sourceIndexPath(
    manifest: WorkstreamManifest,
    sequence: number,
  ): string {
    return join(
      this.sourcesDirectory(manifest),
      `${String(sequence).padStart(4, "0")}.json`,
    );
  }

  private async writeReport(
    manifest: WorkstreamManifest,
    report: Omit<ResearchJobReport, "sequence">,
  ): Promise<string> {
    const directory = this.reportsDirectory(manifest);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const existing = await this.readLatestReport(manifest);
    const sequence = (existing?.sequence ?? 0) + 1;
    const complete: ResearchJobReport = { ...report, sequence };
    const path = join(directory, `${String(sequence).padStart(4, "0")}.json`);
    await writeJsonAtomically(path, complete);
    return path;
  }

  private async writeSourceIndex(
    manifest: WorkstreamManifest,
    report: Omit<ResearchJobReport, "sequence">,
  ): Promise<string> {
    const directory = this.sourcesDirectory(manifest);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const sequence = (await this.readLatestReport(manifest))?.sequence ?? 1;
    const path = this.sourceIndexPath(manifest, sequence);
    await writeJsonAtomically(path, {
      version: 1,
      workstreamId: manifest.id,
      sequence,
      capturedAt: report.capturedAt,
      citations: report.citations,
    });
    return path;
  }

  private async readLatestReport(
    manifest: WorkstreamManifest,
  ): Promise<ResearchJobReport | undefined> {
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
      ) as ResearchJobReport;
    } catch {
      return undefined;
    }
  }
}

export function buildResearchBrief(input: ResearchLaunchInput): string {
  return [
    "# Research-job brief",
    "",
    "## Focused question",
    input.question.trim(),
    "",
    "## Requested scope",
    input.scope.trim(),
    "",
    "Research independently using available non-mutating research tools. Distinguish directly supported evidence from inference. Do not edit the repository or perform consequential external operations. Capture credible source URLs, titles, and concise evidence notes. Do not ask the parent for routine clarification; report a blocker when the question cannot be answered responsibly.",
    "",
    "End with exactly one `<research-job-report>` JSON block and no prose after it:",
    "```json",
    '{"status":"completed|blocked","synthesis":"concise cited synthesis","citations":[{"url":"https://example.com","title":"Source title","note":"evidence this source supports"}],"nextAction":"what the parent should do next","blocker":"required when blocked"}',
    "```",
    "The parent receives only the bounded cited synthesis. Raw tool output and source artifacts remain local to this workstream.",
  ].join("\n");
}

export const renderResearchTimelineEntry: EntryRenderer<
  ResearchTimelineEntry
> = (entry, options, theme) => {
  const data = entry.data;
  if (!isResearchTimelineEntry(data)) return undefined;
  const heading = theme.fg(
    data.status === "completed" ? "success" : "warning",
    `Research ${shortId(data.workstreamId)} · ${data.status}`,
  );
  const compact = [
    heading,
    theme.fg("muted", bound(data.synthesis, 700)),
    theme.fg(
      "dim",
      `${data.citationCount} cited source${data.citationCount === 1 ? "" : "s"} · raw artifacts collapsed`,
    ),
  ].join("\n");
  if (!options.expanded) return new Text(compact, 0, 0);
  return new Text(
    [
      compact,
      "",
      theme.fg("dim", `Report: ${data.reportArtifact}`),
      theme.fg("dim", `Source index: ${data.sourceIndexArtifact}`),
    ].join("\n"),
    0,
    0,
  );
};

function parseResearchReport(
  text: string,
): Record<string, unknown> | undefined {
  const tagged = text.match(
    /<research-job-report>\s*([\s\S]*?)\s*<\/research-job-report>/i,
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

function normalizeResearchReport(
  parsed: Record<string, unknown> | undefined,
  manifest: WorkstreamManifest,
  finalAssistantText: string,
): Omit<ResearchJobReport, "sequence"> {
  const blocker = textField(parsed?.blocker, 700);
  return {
    version: 1,
    workstreamId: manifest.id,
    status: parsed?.status === "blocked" ? "blocked" : "completed",
    question: researchQuestion(manifest.brief),
    synthesis:
      textField(parsed?.synthesis, 1_500) ||
      bound(finalAssistantText, 1_500) ||
      "Research worker settled without a text synthesis.",
    citations: citationList(parsed?.citations),
    nextAction:
      textField(parsed?.nextAction, 700) ||
      "Review the retained research artifacts.",
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

function formatLinkedSynthesis(report: ResearchJobReport): string {
  return bound(
    [
      `Research answer: ${report.synthesis}`,
      ...report.citations.map(
        (citation) =>
          `Source: ${citation.title} — ${citation.url} (${citation.note})`,
      ),
    ].join("\n"),
    MAX_HANDOFF_CHARS,
  );
}

function formatBoundedHandoff(
  report: ResearchJobReport,
  reportArtifact: string,
  sourceIndexArtifact: string,
  linkedTaskWorkstreamId: string | undefined,
  delivery: "delivered" | "unavailable" | undefined,
): string {
  const lines = [
    `Research job ${shortId(report.workstreamId)} ${report.status === "blocked" ? "is blocked" : "completed"}.`,
    `Synthesis: ${report.synthesis}`,
    ...(report.citations.length
      ? [
          "Sources:",
          ...report.citations.map(
            (citation) =>
              `- ${citation.title}: ${citation.url}${citation.note ? ` — ${citation.note}` : ""}`,
          ),
        ]
      : ["Sources: no valid cited sources were retained."]),
    ...(report.blocker ? [`Blocker: ${report.blocker}`] : []),
    `Next action: ${report.nextAction}`,
    ...(linkedTaskWorkstreamId
      ? [
          delivery === "delivered"
            ? `Linked task worker ${shortId(linkedTaskWorkstreamId)} received this cited synthesis.`
            : `Linked task worker ${shortId(linkedTaskWorkstreamId)} was not live; no delivery was attempted.`,
        ]
      : []),
    `Research report: ${reportArtifact}`,
    `Source index: ${sourceIndexArtifact}`,
  ];
  return bound(lines.join("\n"), MAX_HANDOFF_CHARS);
}

function citationList(value: unknown): ResearchCitation[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const citations: ResearchCitation[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const url = validHttpUrl(record.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push({
      url,
      title: textField(record.title, 300) || url,
      note: textField(record.note, 500),
    });
    if (citations.length === 20) break;
  }
  return citations;
}

function validHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

function researchQuestion(brief: string): string {
  const marker = "## Focused question\n";
  const start = brief.indexOf(marker);
  if (start < 0) return "Research question retained in worker brief.";
  return bound(
    brief.slice(start + marker.length).split("\n## ")[0] ?? "",
    1_000,
  );
}

function textField(value: unknown, limit: number): string {
  return typeof value === "string" ? bound(value, limit) : "";
}

function bound(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1)}…`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function isResearchTimelineEntry(
  value: unknown,
): value is ResearchTimelineEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "workstreamId" in value &&
    "sourceIndexArtifact" in value
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
