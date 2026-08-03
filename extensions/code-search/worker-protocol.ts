export const CODE_SEARCH_PROTOCOL_VERSION = 2;

export type CodeSearchCoverage = {
  indexedFiles: number;
  skippedIgnored: number;
  skippedSymlink: number;
  skippedBinary: number;
  skippedOversize: number;
  skippedUnreadable: number;
};

export type CodeSearchIndexFreshness =
  "fresh" | "refreshing" | "partial" | "degraded";

export type CodeSearchWorkerStatus = {
  ready: boolean;
  watching: boolean;
  freshness: CodeSearchIndexFreshness;
  coverage: CodeSearchCoverage;
};

export type CodeSearchSymbol = {
  id: string;
  path: string;
  language: string;
  name: string;
  qualifiedName: string;
  kind: string;
  parentId?: string;
  startByte: number;
  endByte: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  parseHasError: boolean;
};

export type CodeSearchFile = {
  path: string;
  language: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
  lineCount: number;
  parseHasError: boolean;
  indexedAtMs: number;
};

export type CodeSearchWorkerRequest =
  | {
      version: typeof CODE_SEARCH_PROTOCOL_VERSION;
      id: string;
      type: "initialize";
      storagePath: string;
      root: string;
    }
  | {
      version: typeof CODE_SEARCH_PROTOCOL_VERSION;
      id: string;
      type: "status";
    }
  | {
      version: typeof CODE_SEARCH_PROTOCOL_VERSION;
      id: string;
      type: "refresh" | "validate";
      root: string;
      additionalIgnores: string;
      maxFileBytes?: number;
    }
  | {
      version: typeof CODE_SEARCH_PROTOCOL_VERSION;
      id: string;
      type: "watch";
      root: string;
      additionalIgnores: string;
      maxFileBytes?: number;
      enabled: boolean;
    }
  | {
      version: typeof CODE_SEARCH_PROTOCOL_VERSION;
      id: string;
      type: "searchSymbols";
      query: string;
      limit: number;
      path?: string;
      kind?: string;
    }
  | {
      version: typeof CODE_SEARCH_PROTOCOL_VERSION;
      id: string;
      type: "fileSymbols";
      path: string;
    }
  | {
      version: typeof CODE_SEARCH_PROTOCOL_VERSION;
      id: string;
      type: "close";
    }
  | {
      version: typeof CODE_SEARCH_PROTOCOL_VERSION;
      type: "cancel";
      requestId: string;
    };

export type CodeSearchWorkerResponse =
  | {
      version: typeof CODE_SEARCH_PROTOCOL_VERSION;
      id: string;
      ok: true;
      result: CodeSearchWorkerStatus | CodeSearchSymbol[] | { closed: true };
    }
  | {
      version: typeof CODE_SEARCH_PROTOCOL_VERSION;
      id: string;
      ok: false;
      error: string;
    };
