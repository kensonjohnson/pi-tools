import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Diagnostic,
  DiagnosticSeverity,
  Range,
} from "vscode-languageserver-protocol/node";
import { normalizeAvailabilityDetail } from "./inspect.ts";
import type {
  LspDiagnosticRecord,
  LspInspectAvailability,
  LspInspectionAvailabilityDetail,
  LspInspectionResult,
} from "./inspect.ts";

export type NormalizedLspRange = {
  start: { line: number; character: number };
  end: { line: number; character: number };
};

export type NormalizedLspDiagnostic = {
  uri: string;
  path: string | undefined;
  range: NormalizedLspRange;
  severity: "error" | "warning" | "information" | "hint";
  source: string;
  code: string | undefined;
  message: string;
  catalogId: string;
};

export type RenderLspDiagnosticsOptions = {
  rootPath: string;
  maxCount: number;
  maxBytes: number;
};

export type RenderedLspDiagnostics = {
  text: string;
  details: {
    status: LspInspectionResult["status"];
    mode: LspInspectionResult["mode"];
    diagnostics: readonly NormalizedLspDiagnostic[];
    omitted: number;
    unavailable: readonly LspInspectAvailability[];
    availability: readonly LspInspectionAvailabilityDetail[];
    metadata: LspInspectionResult["metadata"];
  };
};

/** Normalizes protocol diagnostics and emits a deterministic, bounded response. */
export function renderLspDiagnostics(
  result: LspInspectionResult,
  options: RenderLspDiagnosticsOptions,
): RenderedLspDiagnostics {
  const diagnostics = result.diagnostics
    .map((record) => normalizeDiagnostic(record, options.rootPath))
    .sort(compareDiagnostics);
  const limit = Math.max(1, Math.floor(options.maxBytes));
  const countLimit = Math.max(0, Math.floor(options.maxCount));
  const availability = normalizedAvailability(result);
  const header = renderHeader(result, diagnostics.length);
  if (result.status !== "ok" && result.status !== "partial") {
    return {
      text: fitText(`${header}\n${renderAvailability(availability)}`, limit),
      details: {
        status: result.status,
        mode: result.mode,
        diagnostics: [],
        omitted: 0,
        unavailable: result.unavailable,
        availability,
        metadata: result.metadata,
      },
    };
  }

  const candidates = diagnostics.slice(0, countLimit);
  const selected: NormalizedLspDiagnostic[] = [];
  for (const candidate of candidates) {
    const proposed = [...selected, candidate];
    const omitted = diagnostics.length - proposed.length;
    if (
      Buffer.byteLength(
        renderSuccess(result, header, proposed, omitted),
        "utf8",
      ) > limit
    )
      break;
    selected.push(candidate);
  }
  const omitted = diagnostics.length - selected.length;
  return {
    text: fitText(renderSuccess(result, header, selected, omitted), limit),
    details: {
      status: result.status,
      mode: result.mode,
      diagnostics: selected,
      omitted,
      unavailable: result.unavailable,
      availability,
      metadata: result.metadata,
    },
  };
}

export function normalizeDiagnostic(
  record: LspDiagnosticRecord,
  rootPath: string,
): NormalizedLspDiagnostic {
  const diagnostic = record.diagnostic;
  return {
    uri: record.uri,
    path: rootRelativePath(rootPath, record.uri),
    range: normalizeRange(diagnostic.range),
    severity: normalizeSeverity(diagnostic.severity),
    source: normalizeText(diagnostic.source) || "lsp",
    code: normalizeCode(diagnostic.code),
    message: normalizeText(diagnostic.message) || "(no diagnostic message)",
    catalogId: record.catalogId,
  };
}

function renderHeader(
  result: LspInspectionResult,
  diagnosticCount: number,
): string {
  const servers = result.metadata.servers.length
    ? result.metadata.servers
        .map(
          (server) =>
            `${server.catalogId}(document=${server.documentDiagnostics ? "yes" : "no"}, workspace=${server.workspaceDiagnostics ? "yes" : "no"})`,
        )
        .join(", ")
    : "none";
  return `LSP diagnostics (${result.mode}): ${result.status}; ${diagnosticCount} diagnostic${diagnosticCount === 1 ? "" : "s"}; freshness=${result.metadata.freshness}; servers=${servers}.`;
}

function renderSuccess(
  result: Extract<LspInspectionResult, { status: "ok" | "partial" }>,
  header: string,
  diagnostics: readonly NormalizedLspDiagnostic[],
  omitted: number,
): string {
  const groups = groupDiagnostics(diagnostics)
    .map(([label, values]) => {
      const uri = values[0]!.uri;
      return `${label}\n  uri=${uri}\n${values.map(renderDiagnostic).join("\n")}`;
    })
    .join("\n\n");
  const sections = [header];
  if (groups) sections.push(groups);
  if (result.status === "partial") {
    sections.push(
      `Partial: ${result.unavailable.join(", ") || "unavailable"} server result${result.unavailable.length === 1 ? " is" : "s are"} unavailable.`,
    );
    sections.push(renderAvailability(normalizedAvailability(result)));
  }
  if (!diagnostics.length && !omitted && result.status === "ok") {
    sections.push("Clean: no diagnostics returned.");
  } else if (omitted) {
    sections.push(
      `Omitted: ${omitted} diagnostic${omitted === 1 ? "" : "s"} due to configured count or byte limit.`,
    );
  }
  return sections.join("\n\n");
}

function groupDiagnostics(
  diagnostics: readonly NormalizedLspDiagnostic[],
): Array<[string, NormalizedLspDiagnostic[]]> {
  const groups = new Map<string, NormalizedLspDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const label = diagnostic.path ?? diagnostic.uri;
    const current = groups.get(label);
    if (current) current.push(diagnostic);
    else groups.set(label, [diagnostic]);
  }
  return [...groups.entries()];
}

function renderDiagnostic(diagnostic: NormalizedLspDiagnostic): string {
  const range = `${diagnostic.range.start.line}:${diagnostic.range.start.character}-${diagnostic.range.end.line}:${diagnostic.range.end.character}`;
  return `  ${diagnostic.severity} source=${diagnostic.source} code=${diagnostic.code ?? "-"} range=${range} message=${diagnostic.message}`;
}

function normalizedAvailability(
  result: LspInspectionResult,
): LspInspectionAvailabilityDetail[] {
  const supplied = result.availability?.length
    ? result.availability
    : result.unavailable.map((status) => ({ status }));
  return supplied.map(normalizeAvailabilityDetail);
}

function renderAvailability(
  details: readonly LspInspectionAvailabilityDetail[],
): string {
  return details
    .map((detail) => {
      const subject = detail.catalogId ?? "managed server";
      return `Availability: ${subject} (${detail.status}): ${detail.message ?? availabilityMessage(detail.status)}`;
    })
    .join("\n");
}

function availabilityMessage(status: LspInspectAvailability): string {
  switch (status) {
    case "unconfigured":
      return "No reviewed managed language server is configured for this request.";
    case "installing":
      return "The reviewed managed language server is still installing; retry after provisioning completes.";
    case "offline":
      return "The managed language server is unavailable while offline.";
    case "unavailable":
      return "The managed language server is currently unavailable.";
    case "broken":
      return "The managed language server failed or its connection is broken.";
    case "timeout":
      return "The language server request timed out.";
    case "unsupported":
      return "The language server does not support this diagnostic request.";
    case "cancelled":
      return "The language server request was cancelled.";
  }
}

function normalizeRange(range: Range): NormalizedLspRange {
  return {
    start: {
      line: nonNegativeInteger(range.start.line) + 1,
      character: nonNegativeInteger(range.start.character) + 1,
    },
    end: {
      line: nonNegativeInteger(range.end.line) + 1,
      character: nonNegativeInteger(range.end.character) + 1,
    },
  };
}

function normalizeSeverity(
  severity: DiagnosticSeverity | undefined,
): NormalizedLspDiagnostic["severity"] {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    default:
      return "hint";
  }
}

function normalizeCode(code: Diagnostic["code"]): string | undefined {
  if (typeof code === "string" || typeof code === "number")
    return normalizeText(String(code)) || undefined;
  if (code && typeof code === "object" && "value" in code) {
    const value = code.value;
    if (typeof value === "string" || typeof value === "number")
      return normalizeText(String(value)) || undefined;
  }
  return undefined;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function rootRelativePath(rootPath: string, uri: string): string | undefined {
  try {
    const path = fileURLToPath(uri);
    const relativePath = relative(resolve(rootPath), path);
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`)
    ) {
      return undefined;
    }
    return relativePath.split(sep).join("/");
  } catch {
    return undefined;
  }
}

function compareDiagnostics(
  left: NormalizedLspDiagnostic,
  right: NormalizedLspDiagnostic,
): number {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    compareText(left.path ?? left.uri, right.path ?? right.uri) ||
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    left.range.end.line - right.range.end.line ||
    left.range.end.character - right.range.end.character ||
    compareText(left.source, right.source) ||
    compareText(left.code ?? "", right.code ?? "") ||
    compareText(left.message, right.message)
  );
}

function severityRank(severity: NormalizedLspDiagnostic["severity"]): number {
  return ["error", "warning", "information", "hint"].indexOf(severity);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function fitText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "…";
  const markerBytes = Buffer.byteLength(marker);
  if (maxBytes <= markerBytes) return marker.slice(0, maxBytes);
  let end = Math.min(Buffer.byteLength(text, "utf8"), maxBytes - markerBytes);
  let slice = Buffer.from(text, "utf8").subarray(0, end);
  while (
    slice.length &&
    (slice[slice.length - 1]! & 0b1100_0000) === 0b1000_0000
  ) {
    end -= 1;
    slice = Buffer.from(text, "utf8").subarray(0, end);
  }
  return `${slice.toString("utf8")}${marker}`;
}
