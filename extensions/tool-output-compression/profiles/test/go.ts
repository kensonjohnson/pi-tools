import type { OutputProfile, ProfileAnalysis } from "../types.ts";

export const GO_TEST_PROFILE_ID = "go-test";
export const GO_TEST_REFERENCE_ID_PLACEHOLDER = "0".repeat(36);

export type GoTestBypassReason =
  | "no-go-package-region"
  | "no-pass-entries"
  | "no-package-summary"
  | "failure-anchor"
  | "malformed-package-summary"
  | "normal-output-not-summary"
  | "composite-output";

export type GoTestPackageSummary = {
  kind: "ok" | "no-test-files";
  packageName: string;
  cached: boolean;
};

export type GoTestProfile = {
  kind: "normal" | "verbose";
  rawBytes: number;
  packages: readonly GoTestPackageSummary[];
  passEntries: number;
  preamble: readonly string[];
  suffix: readonly string[];
  hadTrailingNewline: boolean;
};

export type GoTestAnalysis =
  | { applicable: true; profile: GoTestProfile }
  | { applicable: false; reason: GoTestBypassReason };

const RUN_MARKER = /^\s*=== RUN\s+\S+\s*$/;
const PASS_MARKER = /^\s*--- PASS:\s+\S+\s+\([^)]*\)\s*$/;
const OK_SUMMARY = /^ok\s+(?<packageName>\S+)\s+(?<detail>.+?)\s*$/;
const NO_TEST_SUMMARY = /^\?\s+(?<packageName>\S+)\s+\[no test files\]\s*$/;
const SUMMARY_PREFIX = /^(?:ok|\?)\s+/;
const FAILURE_ANCHOR =
  /^\s*(?:--- FAIL:|FAIL\s*$|panic:|fatal error:|runtime error:)/i;
const OTHER_RUNNER_MARKER = /^\s*(?:RUN\s+v\d|✓\s)/;

export const goTestProfile: OutputProfile = {
  id: GO_TEST_PROFILE_ID,
  settingKey: "goTest",
  label: "Go test",
  toolNames: ["bash"],
  mayMatch: mayContainGoTestOutput,
  analyze(content): ProfileAnalysis {
    const analysis = analyzeGoTestOutput(content);
    if (!analysis.applicable) return analysis;
    const testedPackages = analysis.profile.packages.filter(
      (summary) => summary.kind === "ok",
    );
    return {
      applicable: true,
      rawBytes: analysis.profile.rawBytes,
      summary: {
        testedPackages: testedPackages.length,
        cachedPackages: testedPackages.filter((summary) => summary.cached)
          .length,
        noTestPackages: analysis.profile.packages.filter(
          (summary) => summary.kind === "no-test-files",
        ).length,
        passEntries: analysis.profile.passEntries,
      },
      render: (referenceId) =>
        renderGoTestProfile(analysis.profile, referenceId),
    };
  },
};

/** Recognize complete successful Go package output without command-name hints. */
export function mayContainGoTestOutput(content: string): boolean {
  return content
    .split("\n")
    .some(
      (line) =>
        RUN_MARKER.test(line) || parsePackageSummary(line) !== undefined,
    );
}

export function analyzeGoTestOutput(content: string): GoTestAnalysis {
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailingNewline) lines.pop();

  if (lines.some((line) => FAILURE_ANCHOR.test(line))) {
    return { applicable: false, reason: "failure-anchor" };
  }

  const regionStart = lines.findIndex((line) => RUN_MARKER.test(line));
  if (regionStart < 0) {
    return analyzeNormalGoPackageOutput(lines, hadTrailingNewline, content);
  }

  const parsedSummaries: Array<{
    index: number;
    summary: GoTestPackageSummary;
  }> = [];
  for (let index = regionStart; index < lines.length; index++) {
    const parsed = parsePackageSummary(lines[index]!);
    if (parsed) parsedSummaries.push({ index, summary: parsed });
    else if (SUMMARY_PREFIX.test(lines[index]!)) {
      return { applicable: false, reason: "malformed-package-summary" };
    }
  }
  if (parsedSummaries.length === 0) {
    return { applicable: false, reason: "no-package-summary" };
  }

  const regionEnd = parsedSummaries.at(-1)!.index;
  const region = lines.slice(regionStart, regionEnd + 1);
  if (
    lines.slice(regionEnd + 1).some((line) => OTHER_RUNNER_MARKER.test(line))
  ) {
    return { applicable: false, reason: "composite-output" };
  }
  const passEntries = region.filter((line) => PASS_MARKER.test(line)).length;
  if (passEntries === 0) {
    return { applicable: false, reason: "no-pass-entries" };
  }

  return {
    applicable: true,
    profile: {
      kind: "verbose",
      rawBytes: Buffer.byteLength(content, "utf8"),
      packages: parsedSummaries.map(({ summary }) => summary),
      passEntries,
      preamble: lines.slice(0, regionStart),
      suffix: lines.slice(regionEnd + 1),
      hadTrailingNewline,
    },
  };
}

export function renderGoTestProfile(
  profile: GoTestProfile,
  referenceId: string,
): string {
  const testedPackages = profile.packages.filter(
    (summary) => summary.kind === "ok",
  );
  const cachedPackages = testedPackages.filter((summary) => summary.cached);
  const noTestPackages = profile.packages.filter(
    (summary) => summary.kind === "no-test-files",
  );
  const compact = [
    ...profile.preamble,
    ...(profile.preamble.length > 0 ? [""] : []),
    `Go unit tests passed: ${testedPackages.length} tested ${pluralize(testedPackages.length, "package")} (${cachedPackages.length} cached); ${noTestPackages.length} ${pluralize(noTestPackages.length, "package")} had no tests.`,
    ...(profile.kind === "verbose"
      ? [`Verbose details omitted: ${profile.passEntries} PASS entries.`]
      : []),
    `[Original tool output omitted (${profile.rawBytes} bytes). Retrieve with retrieve_tool_output({ id: "${referenceId}" }) if needed.]`,
    ...profile.suffix,
  ].join("\n");
  return profile.hadTrailingNewline ? `${compact}\n` : compact;
}

export function isGoTestReplacementSmaller(
  visibleContent: string,
  compactContent: string,
): boolean {
  return (
    Buffer.byteLength(compactContent, "utf8") <
    Buffer.byteLength(visibleContent, "utf8")
  );
}

function analyzeNormalGoPackageOutput(
  lines: readonly string[],
  hadTrailingNewline: boolean,
  content: string,
): GoTestAnalysis {
  const regionStart = lines.findIndex(
    (line) => parsePackageSummary(line) !== undefined,
  );
  if (regionStart < 0) {
    return { applicable: false, reason: "no-go-package-region" };
  }

  const packages: GoTestPackageSummary[] = [];
  let regionEnd = regionStart - 1;
  for (let index = regionStart; index < lines.length; index++) {
    const line = lines[index]!;
    const summary = parsePackageSummary(line);
    if (summary) {
      packages.push(summary);
      regionEnd = index;
      continue;
    }
    if (
      line.trim() === "" &&
      lines.slice(index).every((entry) => !entry.trim())
    ) {
      break;
    }
    return { applicable: false, reason: "normal-output-not-summary" };
  }

  return {
    applicable: true,
    profile: {
      kind: "normal",
      rawBytes: Buffer.byteLength(content, "utf8"),
      packages,
      passEntries: 0,
      preamble: lines.slice(0, regionStart),
      suffix: lines.slice(regionEnd + 1),
      hadTrailingNewline,
    },
  };
}

function parsePackageSummary(line: string): GoTestPackageSummary | undefined {
  const noTest = line.match(NO_TEST_SUMMARY);
  if (noTest?.groups?.packageName) {
    return {
      kind: "no-test-files",
      packageName: noTest.groups.packageName,
      cached: false,
    };
  }

  const ok = line.match(OK_SUMMARY);
  if (!ok?.groups?.packageName || !ok.groups.detail) return undefined;
  const detail = ok.groups.detail.trim();
  if (!isGoPassDetail(detail)) return undefined;
  return {
    kind: "ok",
    packageName: ok.groups.packageName,
    cached: detail === "(cached)",
  };
}

function pluralize(value: number, singular: string): string {
  return value === 1 ? singular : `${singular}s`;
}

function isGoPassDetail(detail: string): boolean {
  if (detail === "(cached)") return true;
  return /^\d+(?:\.\d+)?s(?:\s+coverage:\s+\d+(?:\.\d+)?%\s+of statements)?$/.test(
    detail,
  );
}
