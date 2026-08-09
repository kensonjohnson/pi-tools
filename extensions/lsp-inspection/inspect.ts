import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Diagnostic,
  DocumentDiagnosticReport,
  WorkspaceDiagnosticReport,
} from "vscode-languageserver-protocol/node";
import type { LspCatalogId } from "./catalog.ts";
import type { LspOutcome, LspRequestOptions } from "./lsp-client.ts";

export type LspInspectMode = "file" | "workspace";
export type LspInspectAvailability =
  | "unconfigured"
  | "installing"
  | "offline"
  | "unavailable"
  | "broken"
  | "timeout"
  | "unsupported"
  | "cancelled";

export type LspInspectionRequest =
  { mode: "file"; path: string; contents: string } | { mode: "workspace" };

export type LspDiagnosticRecord = {
  uri: string;
  diagnostic: Diagnostic;
  catalogId: LspCatalogId;
};

export type LspInspectionServer = {
  catalogId: LspCatalogId;
  documentDiagnostics: boolean;
  workspaceDiagnostics: boolean;
};

/** A bounded explanation for one unavailable reviewed server. */
export type LspInspectionAvailabilityDetail = {
  status: LspInspectAvailability;
  catalogId?: LspCatalogId;
  message?: string;
};

export const MAX_LSP_AVAILABILITY_MESSAGE_BYTES = 512;

export type LspInspectionMetadata = {
  freshness: "current-contents" | "workspace-pull";
  servers: readonly LspInspectionServer[];
};

export type LspInspectionResult =
  | {
      status: "ok" | "partial";
      mode: LspInspectMode;
      diagnostics: readonly LspDiagnosticRecord[];
      metadata: LspInspectionMetadata;
      unavailable: readonly LspInspectAvailability[];
      availability?: readonly LspInspectionAvailabilityDetail[];
    }
  | {
      status: LspInspectAvailability;
      mode: LspInspectMode;
      diagnostics: readonly [];
      metadata: LspInspectionMetadata;
      unavailable: readonly LspInspectAvailability[];
      availability?: readonly LspInspectionAvailabilityDetail[];
    };

/** The tool boundary depends on this interface rather than provisioning details. */
export type LspInspectionService = {
  inspect(
    rootPath: string,
    request: LspInspectionRequest,
    options?: LspRequestOptions,
  ): Promise<LspInspectionResult>;
};

export type LspDiagnosticsClient = {
  readonly supportsDocumentDiagnostics: boolean;
  readonly supportsWorkspaceDiagnostics: boolean;
  getDiagnostics(uri: string): readonly Diagnostic[];
  documentDiagnostics(
    document: {
      uri: string;
      languageId: string;
      text: string;
      version: number;
    },
    options?: LspRequestOptions,
  ): Promise<LspOutcome<DocumentDiagnosticReport>>;
  workspaceDiagnostics(
    options?: LspRequestOptions,
  ): Promise<LspOutcome<WorkspaceDiagnosticReport>>;
};

export type LspResolvedInspectionServer = {
  catalogId: LspCatalogId;
  client: LspDiagnosticsClient;
};

export type LspInspectionResolution =
  | { status: "ok"; server: LspResolvedInspectionServer }
  | LspInspectionAvailabilityDetail;

/** Runtime integration resolves managed installation and server lifecycle here. */
export type LspInspectionResolver = {
  resolveFile(
    rootPath: string,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<LspInspectionResolution>;
  resolveWorkspace(
    rootPath: string,
    options?: { signal?: AbortSignal },
  ): Promise<readonly LspInspectionResolution[]>;
};

/**
 * Converts resolver/client results into a provisioning-agnostic inspection API.
 * Document versions are session-local so every current-content request advances
 * an LSP document monotonically.
 */
export class LspDiagnosticInspector implements LspInspectionService {
  readonly #resolver: LspInspectionResolver;
  readonly #versions = new Map<string, number>();

  constructor(resolver: LspInspectionResolver) {
    this.#resolver = resolver;
  }

  async inspect(
    rootPath: string,
    request: LspInspectionRequest,
    options: LspRequestOptions = {},
  ): Promise<LspInspectionResult> {
    return request.mode === "file"
      ? this.#inspectFile(rootPath, request, options)
      : this.#inspectWorkspace(rootPath, options);
  }

  async #inspectFile(
    rootPath: string,
    request: Extract<LspInspectionRequest, { mode: "file" }>,
    options: LspRequestOptions,
  ): Promise<LspInspectionResult> {
    const resolved = await this.#resolver.resolveFile(rootPath, request.path, {
      signal: options.signal,
    });
    if (resolved.status !== "ok")
      return unavailable("file", resolved.status, undefined, [resolved]);
    const { server } = resolved;
    const metadata = fileMetadata(server);
    const uri = pathToFileURL(resolve(rootPath, request.path)).toString();
    const version = (this.#versions.get(uri) ?? 0) + 1;
    this.#versions.set(uri, version);
    const report = await server.client.documentDiagnostics(
      {
        uri,
        languageId: languageId(server.catalogId),
        text: request.contents,
        version,
      },
      options,
    );
    if (report.status !== "ok") {
      return unavailable("file", mapClientReason(report.reason), metadata, [
        { status: mapClientReason(report.reason), catalogId: server.catalogId },
      ]);
    }
    const diagnostics =
      report.value.kind === "full"
        ? report.value.items
        : server.client.getDiagnostics(uri);
    return {
      status: "ok",
      mode: "file",
      diagnostics: diagnostics.map((diagnostic) => ({
        uri,
        diagnostic,
        catalogId: server.catalogId,
      })),
      metadata,
      unavailable: [],
      availability: [],
    };
  }

  async #inspectWorkspace(
    rootPath: string,
    options: LspRequestOptions,
  ): Promise<LspInspectionResult> {
    const resolutions = await this.#resolver.resolveWorkspace(rootPath, {
      signal: options.signal,
    });
    const unavailableDetails: LspInspectionAvailabilityDetail[] = [];
    const servers: LspInspectionServer[] = [];
    const diagnostics: LspDiagnosticRecord[] = [];
    let successful = 0;

    for (const resolution of resolutions) {
      if (resolution.status !== "ok") {
        unavailableDetails.push(normalizeAvailabilityDetail(resolution));
        continue;
      }
      const { server } = resolution;
      servers.push(workspaceServerMetadata(server));
      const report = await server.client.workspaceDiagnostics(options);
      if (report.status !== "ok") {
        unavailableDetails.push(
          normalizeAvailabilityDetail({
            status: mapClientReason(report.reason),
            catalogId: server.catalogId,
          }),
        );
        continue;
      }
      successful += 1;
      for (const item of report.value.items) {
        const itemDiagnostics =
          item.kind === "full"
            ? item.items
            : server.client.getDiagnostics(item.uri);
        diagnostics.push(
          ...itemDiagnostics.map((diagnostic) => ({
            uri: item.uri,
            diagnostic,
            catalogId: server.catalogId,
          })),
        );
      }
    }

    const metadata: LspInspectionMetadata = {
      freshness: "workspace-pull",
      servers,
    };
    const availability = uniqueAvailabilityDetails(unavailableDetails);
    const unavailable = uniqueReasons(
      availability.map((detail) => detail.status),
    );
    if (successful === 0) {
      return unavailableResult(
        "workspace",
        unavailable[0] ?? "unconfigured",
        metadata,
        unavailable,
        availability,
      );
    }
    return {
      status: unavailable.length ? "partial" : "ok",
      mode: "workspace",
      diagnostics,
      metadata,
      unavailable,
      availability,
    };
  }
}

function fileMetadata(
  server: LspResolvedInspectionServer,
): LspInspectionMetadata {
  return {
    freshness: "current-contents",
    servers: [workspaceServerMetadata(server)],
  };
}

function workspaceServerMetadata(
  server: LspResolvedInspectionServer,
): LspInspectionServer {
  return {
    catalogId: server.catalogId,
    documentDiagnostics: server.client.supportsDocumentDiagnostics,
    workspaceDiagnostics: server.client.supportsWorkspaceDiagnostics,
  };
}

function unavailable(
  mode: LspInspectMode,
  status: LspInspectAvailability,
  metadata: LspInspectionMetadata = {
    freshness: mode === "file" ? "current-contents" : "workspace-pull",
    servers: [],
  },
  availability: readonly LspInspectionAvailabilityDetail[] = [{ status }],
): LspInspectionResult {
  return unavailableResult(mode, status, metadata, [status], availability);
}

function unavailableResult(
  mode: LspInspectMode,
  status: LspInspectAvailability,
  metadata: LspInspectionMetadata,
  unavailableReasons: readonly LspInspectAvailability[],
  availability: readonly LspInspectionAvailabilityDetail[] = [],
): LspInspectionResult {
  return {
    status,
    mode,
    diagnostics: [],
    metadata,
    unavailable: unavailableReasons,
    availability: uniqueAvailabilityDetails(availability),
  };
}

function mapClientReason(reason: string): LspInspectAvailability {
  switch (reason) {
    case "unconfigured":
    case "offline":
    case "unavailable":
    case "broken":
    case "timeout":
    case "unsupported":
    case "cancelled":
      return reason;
    default:
      return "unavailable";
  }
}

export function normalizeAvailabilityDetail(
  detail: LspInspectionAvailabilityDetail,
): LspInspectionAvailabilityDetail {
  const message = boundedAvailabilityMessage(detail.message);
  return {
    status: detail.status,
    ...(detail.catalogId ? { catalogId: detail.catalogId } : {}),
    ...(message ? { message } : {}),
  };
}

function uniqueAvailabilityDetails(
  details: readonly LspInspectionAvailabilityDetail[],
): LspInspectionAvailabilityDetail[] {
  const unique = new Map<string, LspInspectionAvailabilityDetail>();
  for (const detail of details) {
    const normalized = normalizeAvailabilityDetail(detail);
    const key = `${normalized.status}\u0000${normalized.catalogId ?? ""}\u0000${normalized.message ?? ""}`;
    unique.set(key, normalized);
  }
  return [...unique.values()];
}

function boundedAvailabilityMessage(
  message: string | undefined,
): string | undefined {
  const normalized = message?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (
    Buffer.byteLength(normalized, "utf8") <= MAX_LSP_AVAILABILITY_MESSAGE_BYTES
  ) {
    return normalized;
  }
  const marker = "…";
  let end = MAX_LSP_AVAILABILITY_MESSAGE_BYTES - Buffer.byteLength(marker);
  let bytes = Buffer.from(normalized, "utf8").subarray(0, end);
  while (
    bytes.length &&
    (bytes[bytes.length - 1]! & 0b1100_0000) === 0b1000_0000
  ) {
    end -= 1;
    bytes = Buffer.from(normalized, "utf8").subarray(0, end);
  }
  return `${bytes.toString("utf8")}${marker}`;
}

function uniqueReasons(
  reasons: readonly LspInspectAvailability[],
): LspInspectAvailability[] {
  return [...new Set(reasons)].sort(
    (left, right) => availabilityRank(left) - availabilityRank(right),
  );
}

function availabilityRank(reason: LspInspectAvailability): number {
  return [
    "unconfigured",
    "installing",
    "offline",
    "unavailable",
    "broken",
    "timeout",
    "unsupported",
    "cancelled",
  ].indexOf(reason);
}

function languageId(catalogId: LspCatalogId): string {
  return catalogId === "typescript" ? "typescript" : catalogId;
}
