import { createHash } from "node:crypto";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

export const TOOL_OUTPUT_COMPRESSION_ID = "tool-output-compression";
export const DEFAULT_MODE = "observe" as const;
export const DEFAULT_ELIGIBLE_TOOLS = "read,bash";

/**
 * This is deliberately conservative. Phase 3 must use the same or a smaller
 * model-visible reference before it can claim the projected savings as actual.
 */
export const ESTIMATED_REUSE_REFERENCE_BYTES = Buffer.byteLength(
  "[Duplicate tool output omitted. Use retrieve_tool_output with id <output-id> to recover it.]",
  "utf8",
);

export type CompressionMode = "off" | "observe" | "apply";

export type CompressionSettings = {
  enabled: boolean;
  mode: CompressionMode;
  eligibleTools: readonly string[];
};

export type ToolObservationMetrics = {
  eligibleResults: number;
  outputBytes: number;
  exactReuses: number;
  potentialSavedBytes: number;
};

export type ObservationMetrics = {
  eligibleResults: number;
  outputBytes: number;
  exactReuses: number;
  potentialSavedBytes: number;
  byTool: Record<string, ToolObservationMetrics>;
};

type ToolResultForObservation = Pick<
  ToolResultEvent,
  "toolName" | "content" | "isError"
>;

type TextOnlyContent = {
  encoded: string;
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

export function estimatedTokens(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 4);
}

export function percentage(savedBytes: number, originalBytes: number): number {
  return originalBytes <= 0 ? 0 : (savedBytes / originalBytes) * 100;
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
  ): void {
    if (
      !settings.enabled ||
      settings.mode === "off" ||
      event.isError ||
      !settings.eligibleTools.includes(event.toolName)
    ) {
      return;
    }

    const textOnly = extractTextOnlyContent(event.content);
    if (!textOnly) return;

    const hash = createHash("sha256").update(textOnly.encoded).digest("hex");
    const duplicate = this.seenContentHashes.has(hash);
    this.seenContentHashes.add(hash);

    const tool = this.getToolMetrics(event.toolName);
    this.metrics.eligibleResults++;
    this.metrics.outputBytes += textOnly.outputBytes;
    tool.eligibleResults++;
    tool.outputBytes += textOnly.outputBytes;

    const potentialSavedBytes = duplicate
      ? Math.max(0, textOnly.outputBytes - ESTIMATED_REUSE_REFERENCE_BYTES)
      : 0;
    if (potentialSavedBytes <= 0) return;

    this.metrics.exactReuses++;
    this.metrics.potentialSavedBytes += potentialSavedBytes;
    tool.exactReuses++;
    tool.potentialSavedBytes += potentialSavedBytes;
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
}

function extractTextOnlyContent(
  content: ToolResultEvent["content"],
): TextOnlyContent | undefined {
  if (content.length === 0 || content.some((block) => block.type !== "text")) {
    return undefined;
  }

  const text = content.map((block) => block.text);
  return {
    // The JSON array preserves text-block boundaries, so two results with the
    // same concatenated text but different content blocks are not considered equal.
    encoded: JSON.stringify(text),
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
  };
}

function emptyMetrics(): ObservationMetrics {
  return {
    eligibleResults: 0,
    outputBytes: 0,
    exactReuses: 0,
    potentialSavedBytes: 0,
    byTool: {},
  };
}
