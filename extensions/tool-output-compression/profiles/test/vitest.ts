import type { OutputProfile, ProfileAnalysis } from "../types.ts";

export const VITEST_PROFILE_ID = "vitest";
export const VITEST_REFERENCE_ID_PLACEHOLDER = "0".repeat(36);

export type VitestBypassReason =
  | "no-vitest-region"
  | "no-pass-entries"
  | "malformed-pass-line"
  | "mixed-pass-variants"
  | "malformed-summary"
  | "mismatched-file-totals"
  | "mismatched-test-totals"
  | "unexpected-region-line"
  | "nonempty-suffix"
  | "composite-output";

export type VitestPassVariant = "file" | "test";

export type VitestProfile = {
  rawBytes: number;
  passedTestFiles: number;
  passedTests: number;
  passLines: number;
  passVariant: VitestPassVariant;
  duration: string;
  preamble: readonly string[];
  hadTrailingNewline: boolean;
};

export type VitestAnalysis =
  | { applicable: true; profile: VitestProfile }
  | { applicable: false; reason: VitestBypassReason };

type ParsedPassLine = {
  variant: VitestPassVariant;
  tests: number | undefined;
};

const HEADER = /^\s*RUN\s+v\d+(?:\.\d+)+(?:[-+][^\s]+)?\s+\S.*\s*$/;
const FILE_PASS =
  /^\s*✓\s+.+?\s+\((?<tests>\d+)\s+tests?\)\s+\d+(?:\.\d+)?ms\s*$/;
const TEST_PASS = /^\s*✓\s+.+?\s+>\s+.+\s+\d+(?:\.\d+)?ms\s*$/;
const TEST_FILES_SUMMARY =
  /^\s*Test Files\s+(?<passed>\d+)\s+passed\s+\((?<total>\d+)\)\s*$/;
const TESTS_SUMMARY =
  /^\s*Tests\s+(?<passed>\d+)\s+passed\s+\((?<total>\d+)\)\s*$/;
const START_AT = /^\s*Start at\s+\S.*\s*$/;
const DURATION =
  /^\s*Duration\s+(?<duration>\d+(?:\.\d+)?(?:ms|s|m|h))\s+\(.+\)\s*$/;
const OTHER_RUNNER_MARKER =
  /^\s*(?:=== RUN\s+|--- PASS:|--- FAIL:|(?:ok|\?)\s+\S+\s+)/;

export const vitestProfile: OutputProfile = {
  id: VITEST_PROFILE_ID,
  settingPath: "test.vitest",
  label: "Vitest",
  toolNames: ["bash"],
  mayMatch: mayContainVitestOutput,
  analyze(content): ProfileAnalysis {
    const analysis = analyzeVitestOutput(content);
    if (!analysis.applicable) return analysis;
    return {
      applicable: true,
      rawBytes: analysis.profile.rawBytes,
      summary: {
        passedTestFiles: analysis.profile.passedTestFiles,
        passedTests: analysis.profile.passedTests,
        passLines: analysis.profile.passLines,
      },
      render: (referenceId) =>
        renderVitestProfile(analysis.profile, referenceId),
    };
  },
};

/** Recognize complete standalone successful Vitest terminal output. */
export function mayContainVitestOutput(content: string): boolean {
  const lines = content.split("\n");
  return (
    lines.some((line) => HEADER.test(line)) ||
    (lines.some((line) => line.trimStart().startsWith("Test Files")) &&
      lines.some((line) => line.trimStart().startsWith("Tests")))
  );
}

export function analyzeVitestOutput(content: string): VitestAnalysis {
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailingNewline) lines.pop();

  const headerIndex = lines.findIndex((line) => HEADER.test(line));
  if (headerIndex < 0) {
    return { applicable: false, reason: "no-vitest-region" };
  }

  if (
    lines.slice(0, headerIndex).some((line) => OTHER_RUNNER_MARKER.test(line))
  ) {
    return { applicable: false, reason: "composite-output" };
  }

  let index = skipBlankLines(lines, headerIndex + 1);
  const passes: ParsedPassLine[] = [];
  let passVariant: VitestPassVariant | undefined;
  while (index < lines.length) {
    const pass = parsePassLine(lines[index]!);
    if (!pass) break;
    if (passVariant && pass.variant !== passVariant) {
      return { applicable: false, reason: "mixed-pass-variants" };
    }
    passVariant = pass.variant;
    passes.push(pass);
    index++;
  }
  if (passes.length === 0) {
    return {
      applicable: false,
      reason: lines[index]?.trimStart().startsWith("✓")
        ? "malformed-pass-line"
        : "no-pass-entries",
    };
  }
  if (lines[index]?.trimStart().startsWith("✓")) {
    return { applicable: false, reason: "malformed-pass-line" };
  }

  index = skipBlankLines(lines, index);
  if (!lines[index]?.trimStart().startsWith("Test Files")) {
    return { applicable: false, reason: "unexpected-region-line" };
  }
  const fileSummary = parseSummary(lines[index], TEST_FILES_SUMMARY);
  if (!fileSummary) return { applicable: false, reason: "malformed-summary" };
  if (fileSummary.passed !== fileSummary.total) {
    return { applicable: false, reason: "mismatched-file-totals" };
  }
  index++;

  const testSummary = parseSummary(lines[index], TESTS_SUMMARY);
  if (!testSummary) return { applicable: false, reason: "malformed-summary" };
  if (testSummary.passed !== testSummary.total) {
    return { applicable: false, reason: "mismatched-test-totals" };
  }
  index++;

  if (!START_AT.test(lines[index] ?? "")) {
    return { applicable: false, reason: "malformed-summary" };
  }
  index++;

  const duration = lines[index]?.match(DURATION)?.groups?.duration;
  if (!duration) return { applicable: false, reason: "malformed-summary" };
  index++;

  if (lines.slice(index).some((line) => line.trim() !== "")) {
    return { applicable: false, reason: "nonempty-suffix" };
  }

  if (passVariant === "file") {
    const filePassTests = passes.reduce(
      (total, pass) => total + (pass.tests ?? 0),
      0,
    );
    if (
      passes.length !== fileSummary.total ||
      filePassTests !== testSummary.total
    ) {
      return { applicable: false, reason: "mismatched-test-totals" };
    }
  } else if (passes.length !== testSummary.total) {
    return { applicable: false, reason: "mismatched-test-totals" };
  }

  return {
    applicable: true,
    profile: {
      rawBytes: Buffer.byteLength(content, "utf8"),
      passedTestFiles: fileSummary.total,
      passedTests: testSummary.total,
      passLines: passes.length,
      passVariant,
      duration,
      preamble: lines.slice(0, headerIndex),
      hadTrailingNewline,
    },
  };
}

export function renderVitestProfile(
  profile: VitestProfile,
  referenceId: string,
): string {
  const compact = [
    ...profile.preamble,
    ...(profile.preamble.length > 0 && profile.preamble.at(-1) !== ""
      ? [""]
      : []),
    `Vitest passed: ${profile.passedTestFiles} test files; ${profile.passedTests} tests in ${profile.duration}.`,
    `[Original tool output omitted (${profile.rawBytes} bytes). Retrieve with retrieve_tool_output({ id: "${referenceId}" }) if needed.]`,
  ].join("\n");
  return profile.hadTrailingNewline ? `${compact}\n` : compact;
}

export function isVitestReplacementSmaller(
  visibleContent: string,
  compactContent: string,
): boolean {
  return (
    Buffer.byteLength(compactContent, "utf8") <
    Buffer.byteLength(visibleContent, "utf8")
  );
}

function parsePassLine(line: string): ParsedPassLine | undefined {
  const file = line.match(FILE_PASS);
  if (file?.groups?.tests) {
    return { variant: "file", tests: Number(file.groups.tests) };
  }
  if (TEST_PASS.test(line)) return { variant: "test", tests: undefined };
  return undefined;
}

function parseSummary(
  line: string | undefined,
  pattern: RegExp,
): { passed: number; total: number } | undefined {
  const match = line?.match(pattern);
  if (!match?.groups?.passed || !match.groups.total) return undefined;
  return {
    passed: Number(match.groups.passed),
    total: Number(match.groups.total),
  };
}

function skipBlankLines(lines: readonly string[], index: number): number {
  while (lines[index]?.trim() === "") index++;
  return index;
}
