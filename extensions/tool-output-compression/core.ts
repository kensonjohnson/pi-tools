import { createHash } from "node:crypto";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

export const TOOL_OUTPUT_COMPRESSION_ID = "tool-output-compression";
export const DEFAULT_MODE = "observe" as const;
export const DEFAULT_ELIGIBLE_TOOLS = "read,bash";
export const DEFAULT_PROFILE_MODE = "observe" as const;
export const MINIMUM_REUSE_SAVED_BYTES = 16;
const REFERENCE_ID_PLACEHOLDER = "0".repeat(36);
const REFERENCE_SIZE_PLACEHOLDER = 9_999_999_999_999;

export type CompressionMode = "off" | "observe" | "apply";

export type CompressionSettings = {
  enabled: boolean;
  mode: CompressionMode;
  eligibleTools: readonly string[];
  profileModes: Readonly<Record<string, CompressionMode>>;
};

export type ProfileObservationMetrics = {
  candidates: number;
  applied: number;
  visibleBytes: number;
  rawBytes: number;
  projectedCompactBytes: number;
  potentialSavedBytes: number;
  actualSavedBytes: number;
  recoveredFullOutput: number;
  summary: Record<string, number>;
  bypasses: Record<string, number>;
};

export type ToolObservationMetrics = {
  eligibleResults: number;
  outputBytes: number;
  exactReuses: number;
  potentialSavedBytes: number;
  appliedReuses: number;
  actualSavedBytes: number;
};

export type ObservationMetrics = {
  eligibleResults: number;
  outputBytes: number;
  exactReuses: number;
  potentialSavedBytes: number;
  appliedReuses: number;
  actualSavedBytes: number;
  byTool: Record<string, ToolObservationMetrics>;
  profiles: Record<string, ProfileObservationMetrics>;
};

export type ClassifiedTextResult = {
  content: string;
  contentHash: string;
  outputBytes: number;
};

type ToolResultForObservation = Pick<
  ToolResultEvent,
  "toolName" | "content" | "isError"
>;

type TextOnlyContent = {
  encoded: string;
  content: string;
  outputBytes: number;
};

export function parseEligibleTools(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((toolName) => toolName.trim())
        .filter(Boolean),
    ),
  );
}

export function resolveCompressionMode(value: unknown): CompressionMode {
  return value === "off" || value === "observe" || value === "apply"
    ? value
    : DEFAULT_MODE;
}

export function resolveProfileMode(
  settings: CompressionSettings,
  profileId: string,
): CompressionMode {
  if (!settings.enabled || settings.mode === "off") return "off";
  if (settings.mode === "observe") return "observe";
  return settings.profileModes[profileId] ?? DEFAULT_PROFILE_MODE;
}

export function estimatedTokens(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 4);
}

export function percentage(savedBytes: number, originalBytes: number): number {
  return originalBytes <= 0 ? 0 : (savedBytes / originalBytes) * 100;
}

export function buildReuseReference(id: string, originalBytes: number): string {
  return `[Duplicate tool output omitted (${originalBytes} bytes). Retrieve with retrieve_tool_output({ id: "${id}" }) if needed.]`;
}

/** Conservative upper bound for the compact V1 reuse reference. */
export const ESTIMATED_REUSE_REFERENCE_BYTES = Buffer.byteLength(
  buildReuseReference(REFERENCE_ID_PLACEHOLDER, REFERENCE_SIZE_PLACEHOLDER),
  "utf8",
);

export function reusableSavingsBytes(
  outputBytes: number,
  referenceBytes = ESTIMATED_REUSE_REFERENCE_BYTES,
): number {
  const saved = outputBytes - referenceBytes;
  return saved >= MINIMUM_REUSE_SAVED_BYTES ? saved : 0;
}

export function classifyEligibleTextResult(
  event: ToolResultForObservation,
  settings: CompressionSettings,
): ClassifiedTextResult | undefined {
  if (
    !settings.enabled ||
    settings.mode === "off" ||
    event.isError ||
    !settings.eligibleTools.includes(event.toolName)
  ) {
    return undefined;
  }

  const textOnly = extractTextOnlyContent(event.content);
  if (!textOnly) return undefined;

  return {
    content: textOnly.content,
    contentHash: createHash("sha256").update(textOnly.encoded).digest("hex"),
    outputBytes: textOnly.outputBytes,
  };
}

export class ObservationTracker {
  private seenContentHashes = new Set<string>();
  private metrics: ObservationMetrics = emptyMetrics();

  reset(): void {
    this.seenContentHashes.clear();
    this.metrics = emptyMetrics();
  }

  observe(
    event: ToolResultForObservation,
    settings: CompressionSettings,
  ): ClassifiedTextResult | undefined {
    const classified = classifyEligibleTextResult(event, settings);
    if (!classified) return undefined;

    const duplicate = this.seenContentHashes.has(classified.contentHash);
    this.seenContentHashes.add(classified.contentHash);

    const tool = this.getToolMetrics(event.toolName);
    this.metrics.eligibleResults++;
    this.metrics.outputBytes += classified.outputBytes;
    tool.eligibleResults++;
    tool.outputBytes += classified.outputBytes;

    const potentialSavedBytes = duplicate
      ? reusableSavingsBytes(classified.outputBytes)
      : 0;
    if (potentialSavedBytes > 0) {
      this.metrics.exactReuses++;
      this.metrics.potentialSavedBytes += potentialSavedBytes;
      tool.exactReuses++;
      tool.potentialSavedBytes += potentialSavedBytes;
    }

    return classified;
  }

  recordProfileBypass(profileId: string, reason: string): void {
    const metrics = this.getProfileMetrics(profileId);
    metrics.bypasses[reason] = (metrics.bypasses[reason] ?? 0) + 1;
  }

  recordProfileCandidate(
    profileId: string,
    values: {
      visibleBytes: number;
      rawBytes: number;
      compactBytes: number;
      summary: Readonly<Record<string, number>>;
      recoveredFullOutput: boolean;
    },
  ): void {
    const metrics = this.getProfileMetrics(profileId);
    metrics.candidates++;
    metrics.visibleBytes += values.visibleBytes;
    metrics.rawBytes += values.rawBytes;
    metrics.projectedCompactBytes += values.compactBytes;
    metrics.potentialSavedBytes += Math.max(
      0,
      values.visibleBytes - values.compactBytes,
    );
    for (const [name, value] of Object.entries(values.summary)) {
      metrics.summary[name] = (metrics.summary[name] ?? 0) + value;
    }
    if (values.recoveredFullOutput) metrics.recoveredFullOutput++;
  }

  recordProfileApplied(
    profileId: string,
    visibleBytes: number,
    compactBytes: number,
  ): void {
    const savedBytes = Math.max(0, visibleBytes - compactBytes);
    if (savedBytes <= 0) return;
    const metrics = this.getProfileMetrics(profileId);
    metrics.applied++;
    metrics.actualSavedBytes += savedBytes;
  }

  recordApplied(
    toolName: string,
    outputBytes: number,
    referenceBytes: number,
  ): void {
    const savedBytes = reusableSavingsBytes(outputBytes, referenceBytes);
    if (savedBytes <= 0) return;

    const tool = this.getToolMetrics(toolName);
    this.metrics.appliedReuses++;
    this.metrics.actualSavedBytes += savedBytes;
    tool.appliedReuses++;
    tool.actualSavedBytes += savedBytes;
  }

  snapshot(): ObservationMetrics {
    return structuredClone(this.metrics);
  }

  private getToolMetrics(toolName: string): ToolObservationMetrics {
    const existing = this.metrics.byTool[toolName];
    if (existing) return existing;

    const created = emptyToolMetrics();
    this.metrics.byTool[toolName] = created;
    return created;
  }

  private getProfileMetrics(profileId: string): ProfileObservationMetrics {
    const existing = this.metrics.profiles[profileId];
    if (existing) return existing;

    const created = emptyProfileMetrics();
    this.metrics.profiles[profileId] = created;
    return created;
  }
}

function extractTextOnlyContent(
  content: ToolResultEvent["content"],
): TextOnlyContent | undefined {
  if (content.length === 0 || content.some((block) => block.type !== "text")) {
    return undefined;
  }

  const text = content.map((block) => block.text);
  return {
    encoded: JSON.stringify(text),
    content: text.join(""),
    outputBytes: text.reduce(
      (total, value) => total + Buffer.byteLength(value, "utf8"),
      0,
    ),
  };
}

function emptyToolMetrics(): ToolObservationMetrics {
  return {
    eligibleResults: 0,
    outputBytes: 0,
    exactReuses: 0,
    potentialSavedBytes: 0,
    appliedReuses: 0,
    actualSavedBytes: 0,
  };
}

function emptyMetrics(): ObservationMetrics {
  return {
    eligibleResults: 0,
    outputBytes: 0,
    exactReuses: 0,
    potentialSavedBytes: 0,
    appliedReuses: 0,
    actualSavedBytes: 0,
    byTool: {},
    profiles: {},
  };
}

function emptyProfileMetrics(): ProfileObservationMetrics {
  return {
    candidates: 0,
    applied: 0,
    visibleBytes: 0,
    rawBytes: 0,
    projectedCompactBytes: 0,
    potentialSavedBytes: 0,
    actualSavedBytes: 0,
    recoveredFullOutput: 0,
    summary: {},
    bypasses: {},
  };
}
