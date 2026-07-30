import type { RawOutputProbe } from "../../raw-capture.ts";
import type {
  OutputProfile,
  ProfileAnalysis,
  ProfileRenderOptions,
} from "../types.ts";

export const JSON_PROFILE_ID = "json";
export const JSON_REFERENCE_ID_PLACEHOLDER = "0".repeat(36);

export type JsonBypassReason = "no-json-output";

export type JsonRegion = {
  start: number;
  end: number;
};

export type JsonOutputProfile = {
  kind: "json" | "jsonl" | "embedded";
  rawBytes: number;
  compactContent: string;
  regions: readonly JsonRegion[];
};

export type JsonAnalysis =
  | { applicable: true; profile: JsonOutputProfile }
  | { applicable: false; reason: JsonBypassReason };

export const jsonProfile: OutputProfile = {
  id: JSON_PROFILE_ID,
  settingPath: "structured.json",
  label: "JSON/JSONL",
  toolNames: ["bash"],
  mayMatch: mayContainJsonOutput,
  mayMatchRecoveredRaw: mayContainJsonRawProbe,
  analyze(content): ProfileAnalysis {
    const analysis = analyzeJsonOutput(content);
    if (!analysis.applicable) return analysis;
    return {
      applicable: true,
      rawBytes: analysis.profile.rawBytes,
      summary: {
        jsonValues: analysis.profile.regions.length,
        embeddedValues:
          analysis.profile.kind === "embedded"
            ? analysis.profile.regions.length
            : 0,
        jsonlValues:
          analysis.profile.kind === "jsonl"
            ? analysis.profile.regions.length
            : 0,
      },
      render: (referenceId, options) =>
        renderJsonProfile(analysis.profile, referenceId, options),
    };
  },
};

/** Recognize valid complete JSON/JSONL first, then safe line-bounded JSON values. */
export function mayContainJsonOutput(content: string): boolean {
  return content.includes("{") || content.includes("[");
}

/**
 * Probe only ASCII structural bytes; arbitrary probe boundaries never need UTF-8
 * decoding. A positive result is merely permission for bounded full capture.
 */
export function mayContainJsonRawProbe(probe: RawOutputProbe): boolean {
  return (
    hasLineBoundedJsonStart(probe.head) || hasLineBoundedJsonStart(probe.tail)
  );
}

export function analyzeJsonOutput(content: string): JsonAnalysis {
  const standalone = analyzeStandaloneJson(content);
  if (standalone) return { applicable: true, profile: standalone };

  const jsonl = analyzeJsonl(content);
  if (jsonl) return { applicable: true, profile: jsonl };

  const regions = findLineBoundedJsonRegions(content);
  if (regions.length === 0) {
    return { applicable: false, reason: "no-json-output" };
  }

  return {
    applicable: true,
    profile: {
      kind: "embedded",
      rawBytes: Buffer.byteLength(content, "utf8"),
      compactContent: replaceRegions(content, regions),
      regions,
    },
  };
}

export function renderJsonProfile(
  profile: JsonOutputProfile,
  referenceId: string,
  options?: ProfileRenderOptions,
): string {
  const full = renderCompleteJsonProfile(profile, referenceId);
  if (
    options?.rawSource !== "full-output-path" ||
    options.visibleBytes > Buffer.byteLength(full, "utf8")
  ) {
    return full;
  }
  return renderMinifiedJsonTail(profile, referenceId, options.visibleBytes);
}

function renderCompleteJsonProfile(
  profile: JsonOutputProfile,
  referenceId: string,
): string {
  const separator = profile.compactContent.endsWith("\n") ? "" : "\n";
  return `${profile.compactContent}${separator}[Original JSON output available (${profile.rawBytes} bytes). Retrieve with retrieve_tool_output({ id: "${referenceId}" }) if needed.]`;
}

function renderMinifiedJsonTail(
  profile: JsonOutputProfile,
  referenceId: string,
  visibleBytes: number,
): string {
  const header = `[Minified JSON tail; original output is incomplete. Retrieve with retrieve_tool_output({ id: "${referenceId}" }) for the complete raw output.]`;
  const budget = visibleBytes - Buffer.byteLength(header, "utf8") - 2;
  if (budget <= 0) return header;

  let tail = utf8Suffix(profile.compactContent, budget);
  if (profile.kind === "jsonl") {
    const recordBoundary = tail.indexOf("\n");
    if (recordBoundary >= 0) tail = tail.slice(recordBoundary + 1);
  }
  return `${header}\n${tail}`;
}

function utf8Suffix(content: string, maxBytes: number): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength <= maxBytes) return content;

  let start = Math.max(0, bytes.byteLength - maxBytes);
  while (
    start < bytes.byteLength &&
    (bytes[start]! & 0b1100_0000) === 0b1000_0000
  ) {
    start++;
  }
  return bytes.subarray(start).toString("utf8");
}

export function isJsonReplacementSmaller(
  visibleContent: string,
  compactContent: string,
): boolean {
  return (
    Buffer.byteLength(compactContent, "utf8") <
    Buffer.byteLength(visibleContent, "utf8")
  );
}

export function findLineBoundedJsonRegions(content: string): JsonRegion[] {
  const regions: JsonRegion[] = [];
  let lineStart = 0;

  while (lineStart < content.length) {
    const lineEnd = nextLineEnd(content, lineStart);
    let start = lineStart;
    while (content[start] === " " || content[start] === "\t") start++;

    if (content[start] === "{" || content[start] === "[") {
      const end = findJsonValueEnd(content, start);
      if (
        end !== undefined &&
        isWhitespaceThroughLineEnd(content, end) &&
        parsesObjectOrArray(content.slice(start, end))
      ) {
        regions.push({ start, end });
        lineStart = nextLineStart(content, nextLineEnd(content, end));
        continue;
      }
    }

    lineStart = nextLineStart(content, lineEnd);
  }

  return regions;
}

function analyzeStandaloneJson(content: string): JsonOutputProfile | undefined {
  if (!parsesObjectOrArray(content)) return undefined;
  const compactContent = minifyJsonWhitespace(content);
  if (!parsesObjectOrArray(compactContent)) return undefined;
  return {
    kind: "json",
    rawBytes: Buffer.byteLength(content, "utf8"),
    compactContent,
    regions: [{ start: 0, end: content.length }],
  };
}

function analyzeJsonl(content: string): JsonOutputProfile | undefined {
  const lines = splitJsonlRecords(content);
  if (!lines || !lines.every(parsesObjectOrArray)) return undefined;
  const compactLines = lines.map(minifyJsonWhitespace);
  if (!compactLines.every(parsesObjectOrArray)) return undefined;
  return {
    kind: "jsonl",
    rawBytes: Buffer.byteLength(content, "utf8"),
    compactContent: compactLines.join("\n"),
    regions: jsonlRegions(lines),
  };
}

function splitJsonlRecords(content: string): string[] | undefined {
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  if (lines.length < 2 || lines.some((line) => !line.trim())) return undefined;
  return lines;
}

function jsonlRegions(lines: readonly string[]): JsonRegion[] {
  let start = 0;
  return lines.map((line) => {
    const region = { start, end: start + line.length };
    start = region.end + 1;
    return region;
  });
}

function parsesObjectOrArray(content: string): boolean {
  try {
    const value: unknown = JSON.parse(content);
    return (
      Array.isArray(value) || (typeof value === "object" && value !== null)
    );
  } catch {
    return false;
  }
}

function minifyJsonWhitespace(content: string): string {
  let compact = "";
  let inString = false;
  let escaped = false;

  for (const character of content) {
    if (inString) {
      compact += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      compact += character;
      inString = true;
    } else if (!isJsonWhitespace(character)) {
      compact += character;
    }
  }

  return compact;
}

function replaceRegions(
  content: string,
  regions: readonly JsonRegion[],
): string {
  let compact = "";
  let cursor = 0;
  for (const region of regions) {
    compact += content.slice(cursor, region.start);
    compact += minifyJsonWhitespace(content.slice(region.start, region.end));
    cursor = region.end;
  }
  return compact + content.slice(cursor);
}

function findJsonValueEnd(content: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index++) {
    const character = content[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") depth++;
    if (character === "}" || character === "]") {
      depth--;
      if (depth === 0) return index + 1;
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function isWhitespaceThroughLineEnd(content: string, start: number): boolean {
  const lineEnd = nextLineEnd(content, start);
  for (let index = start; index < lineEnd; index++) {
    if (
      content[index] !== " " &&
      content[index] !== "\t" &&
      content[index] !== "\r"
    ) {
      return false;
    }
  }
  return true;
}

function nextLineEnd(content: string, start: number): number {
  const newline = content.indexOf("\n", start);
  return newline < 0 ? content.length : newline;
}

function nextLineStart(content: string, lineEnd: number): number {
  return lineEnd < content.length ? lineEnd + 1 : content.length;
}

function hasLineBoundedJsonStart(bytes: Uint8Array): boolean {
  let atLineStart = true;
  let indentOnly = true;
  for (const byte of bytes) {
    if (atLineStart && (byte === 0x7b || byte === 0x5b) && indentOnly) {
      return true;
    }
    if (byte === 0x0a) {
      atLineStart = true;
      indentOnly = true;
    } else if (
      atLineStart &&
      (byte === 0x20 || byte === 0x09 || byte === 0x0d)
    ) {
      // Keep scanning indentation at a physical line start.
    } else {
      atLineStart = false;
      indentOnly = false;
    }
  }
  return false;
}

function isJsonWhitespace(character: string): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\r" ||
    character === "\n"
  );
}
