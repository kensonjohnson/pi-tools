import type { RawOutputProbe } from "../../raw-capture.ts";
import type { OutputProfile, ProfileAnalysis } from "../types.ts";

export const SEARCH_RECORDS_PROFILE_ID = "search-records";
export const SEARCH_RECORDS_REFERENCE_ID_PLACEHOLDER = "0".repeat(36);

export type SearchRecordBypassReason =
  | "no-search-command"
  | "empty-output"
  | "terminal-control"
  | "nul-byte"
  | "blank-line"
  | "non-record-line"
  | "ambiguous-record"
  | "no-repeated-prefix";

export type SearchRecord = {
  prefix: string;
  lineToken: string;
  suffix: string;
};

export type SearchRecordGroup = {
  prefix: string;
  records: readonly SearchRecord[];
};

export type SearchRecordsProfile = {
  rawBytes: number;
  groups: readonly SearchRecordGroup[];
  hadTrailingNewline: boolean;
};

export type SearchRecordsAnalysis =
  | { applicable: true; profile: SearchRecordsProfile }
  | { applicable: false; reason: SearchRecordBypassReason };

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RECORD_DELIMITER = /:([0-9]+):/g;

export const searchRecordsProfile: OutputProfile = {
  id: SEARCH_RECORDS_PROFILE_ID,
  settingPath: "search.records",
  label: "rg/grep search records",
  toolNames: ["bash"],
  mayMatch: (content, context) =>
    mayContainSearchRecords(content, context?.bashCommand ?? ""),
  mayMatchRecoveredRaw: (probe, context) =>
    mayContainSearchRecordRawProbe(probe, context?.bashCommand ?? ""),
  analyze(content, context): ProfileAnalysis {
    const analysis = analyzeSearchRecordsOutput(
      content,
      context?.bashCommand ?? "",
    );
    if (!analysis.applicable) return analysis;
    return {
      applicable: true,
      rawBytes: analysis.profile.rawBytes,
      summary: searchRecordSummary(analysis.profile),
      render: (referenceId) =>
        renderSearchRecordsProfile(analysis.profile, referenceId),
    };
  },
};

/**
 * Recognize only a command word executed in a shell segment. This is purposely
 * narrower than a full POSIX shell parser: uncertain quoting, substitutions,
 * redirections, and compound syntax fail closed.
 */
export function hasSearchCommandSegment(command: string): boolean {
  const segments = lexShellCommandSegments(command);
  if (!segments) return false;

  return segments.some((segment) => isSearchCommandSegment(segment));
}

/**
 * Analyze opaque `prefix:<decimal>:suffix` records without claiming that the
 * prefix is a path. Every accepted line has exactly one possible delimiter.
 */
export function analyzeSearchRecordsOutput(
  content: string,
  command: string,
): SearchRecordsAnalysis {
  if (!hasSearchCommandSegment(command)) {
    return { applicable: false, reason: "no-search-command" };
  }
  if (!content) return { applicable: false, reason: "empty-output" };
  if (content.includes("\0")) return { applicable: false, reason: "nul-byte" };
  if (content.includes("\u001b")) {
    return { applicable: false, reason: "terminal-control" };
  }

  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailingNewline) lines.pop();
  if (lines.length === 0) return { applicable: false, reason: "empty-output" };

  const records: SearchRecord[] = [];
  for (const line of lines) {
    if (!line) return { applicable: false, reason: "blank-line" };
    const parsed = parseSearchRecord(line);
    if (!parsed) {
      return {
        applicable: false,
        reason:
          countRecordDelimiters(line) > 1
            ? "ambiguous-record"
            : "non-record-line",
      };
    }
    records.push(parsed);
  }

  const groups = groupContiguousPrefixes(records);
  if (!groups.some((group) => group.records.length >= 2)) {
    return { applicable: false, reason: "no-repeated-prefix" };
  }

  return {
    applicable: true,
    profile: {
      rawBytes: Buffer.byteLength(content, "utf8"),
      groups,
      hadTrailingNewline,
    },
  };
}

/** Cheap visible-content prefilter; full analysis remains authoritative. */
export function mayContainSearchRecords(
  content: string,
  command: string,
): boolean {
  return hasSearchCommandSegment(command) && content.includes(":");
}

/** Binary prefilter only; complete raw analysis remains authoritative. */
export function mayContainSearchRecordRawProbe(
  probe: RawOutputProbe,
  command: string,
): boolean {
  return (
    hasSearchCommandSegment(command) &&
    (hasRecordDelimiterBytes(probe.head) || hasRecordDelimiterBytes(probe.tail))
  );
}

export function renderSearchRecordsProfile(
  profile: SearchRecordsProfile,
  referenceId: string,
): string {
  const header =
    "[Grouped exact search records; each bullet preserves the prefix before its sole :<line>: delimiter.]";
  const body = renderSearchRecordBody(profile);
  const separator = body.endsWith("\n") ? "" : "\n";
  return `${header}\n${body}${separator}[Original search output available (${profile.rawBytes} bytes). Retrieve with retrieve_tool_output({ id: \"${referenceId}\" }) if needed.]`;
}

/** Render just the reversible record body; callers add explanatory/retrieval text. */
export function renderSearchRecordBody(profile: SearchRecordsProfile): string {
  const body = profile.groups
    .map((group) =>
      [
        `• ${group.prefix}`,
        ...group.records.map(
          (record) => `  ${record.lineToken}:${record.suffix}`,
        ),
      ].join("\n"),
    )
    .join("\n");
  return profile.hadTrailingNewline ? `${body}\n` : body;
}

/** Test-only inverse for the tagged record body. */
export function decodeSearchRecordBody(body: string): string | undefined {
  const hadTrailingNewline = body.endsWith("\n");
  const lines = body.split("\n");
  if (hadTrailingNewline) lines.pop();
  if (lines.length === 0) return undefined;

  const records: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = lines[index]!;
    if (!header.startsWith("• ")) return undefined;
    const prefix = header.slice(2);
    index++;

    let groupRecords = 0;
    while (index < lines.length && lines[index]!.startsWith("  ")) {
      const encoded = lines[index]!.slice(2);
      const match = encoded.match(/^([0-9]+):([\s\S]*)$/);
      if (!match) return undefined;
      records.push(`${prefix}:${encoded}`);
      groupRecords++;
      index++;
    }
    if (groupRecords === 0) return undefined;
  }

  const decoded = records.join("\n");
  return hadTrailingNewline ? `${decoded}\n` : decoded;
}

export function isSearchRecordReplacementSmaller(
  visibleContent: string,
  compactContent: string,
): boolean {
  return (
    Buffer.byteLength(compactContent, "utf8") <
    Buffer.byteLength(visibleContent, "utf8")
  );
}

export function searchRecordSummary(profile: SearchRecordsProfile): {
  records: number;
  prefixGroups: number;
  factoredRecords: number;
} {
  return {
    records: profile.groups.reduce(
      (total, group) => total + group.records.length,
      0,
    ),
    prefixGroups: profile.groups.length,
    factoredRecords: profile.groups
      .filter((group) => group.records.length >= 2)
      .reduce((total, group) => total + group.records.length, 0),
  };
}

function lexShellCommandSegments(command: string): string[][] | undefined {
  const segments: string[][] = [];
  let segment: string[] = [];
  let word = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;

  const finishWord = () => {
    if (!word) return;
    segment.push(word);
    word = "";
  };
  const finishSegment = () => {
    finishWord();
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    const next = command[index + 1];

    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }

    if (quote === "single") {
      if (character === "'") quote = undefined;
      else word += character;
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        escaped = true;
      } else if (
        character === "`" ||
        (character === "$" && (next === "(" || next === "{"))
      ) {
        return undefined;
      } else {
        word += character;
      }
      continue;
    }

    if (character === "\\") {
      escaped = true;
    } else if (character === "'") {
      quote = "single";
    } else if (character === '"') {
      quote = "double";
    } else if (
      character === "`" ||
      (character === "$" && (next === "(" || next === "{"))
    ) {
      return undefined;
    } else if (
      character === ">" ||
      character === "<" ||
      character === "(" ||
      character === ")"
    ) {
      return undefined;
    } else if (character === "|") {
      finishSegment();
      if (next === "|") index++;
    } else if (character === "&" || character === ";" || character === "\n") {
      finishSegment();
      if (character === "&" && next === "&") index++;
    } else if (/\s/.test(character)) {
      finishWord();
    } else {
      word += character;
    }
  }

  if (quote || escaped) return undefined;
  finishSegment();
  return segments;
}

function isSearchCommandSegment(segment: readonly string[]): boolean {
  let index = 0;
  while (index < segment.length && ASSIGNMENT.test(segment[index]!)) index++;
  if (segment[index] === "command") index++;
  const commandWord = segment[index];
  if (!commandWord) return false;
  const basename = commandWord.slice(commandWord.lastIndexOf("/") + 1);
  return basename === "rg" || basename === "grep";
}

function parseSearchRecord(line: string): SearchRecord | undefined {
  RECORD_DELIMITER.lastIndex = 0;
  const first = RECORD_DELIMITER.exec(line);
  if (!first || first.index === 0) return undefined;
  const second = RECORD_DELIMITER.exec(line);
  if (second) return undefined;
  return {
    prefix: line.slice(0, first.index),
    lineToken: first[1]!,
    suffix: line.slice(first.index + first[0].length),
  };
}

function countRecordDelimiters(line: string): number {
  return Array.from(line.matchAll(/:[0-9]+:/g)).length;
}

function hasRecordDelimiterBytes(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0x3a) continue;
    let cursor = index + 1;
    const firstDigit = cursor;
    while (
      cursor < bytes.length &&
      bytes[cursor]! >= 0x30 &&
      bytes[cursor]! <= 0x39
    ) {
      cursor++;
    }
    if (cursor > firstDigit && bytes[cursor] === 0x3a) return true;
  }
  return false;
}

function groupContiguousPrefixes(
  records: readonly SearchRecord[],
): SearchRecordGroup[] {
  const groups: SearchRecordGroup[] = [];
  for (const record of records) {
    const last = groups.at(-1);
    if (last?.prefix === record.prefix) {
      groups[groups.length - 1] = {
        ...last,
        records: [...last.records, record],
      };
    } else {
      groups.push({ prefix: record.prefix, records: [record] });
    }
  }
  return groups;
}
