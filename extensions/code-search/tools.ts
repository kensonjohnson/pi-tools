import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type {
  CodeSearchLocatedSymbol,
  CodeSearchSymbol,
  CodeSearchWorkerStatus,
} from "./worker-protocol.ts";
import { CodeSearchWorkerClient } from "./worker-client.ts";

const MAX_RESULT_BYTES = 48 * 1024;

type OutputStyle = "compact" | "structured";

export type CodeSearchToolRuntime = {
  root: string;
  additionalIgnores: string;
  outputStyle: OutputStyle;
  searchMaxResults: number;
  searchTokenBudget: number;
  retrievalTokenBudget: number;
  contextTokenBudget: number;
  worker: CodeSearchWorkerClient;
};

export function registerCodeSearchTools(
  pi: ExtensionAPI,
  getRuntime: () => CodeSearchToolRuntime | undefined,
): void {
  pi.registerTool({
    name: "code_search",
    label: "Code Search",
    description: "Find indexed AST symbols in the current trusted project.",
    promptSnippet: "Find source-free local AST symbol metadata",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200 }),
      path: Type.Optional(Type.String({ maxLength: 1_024 })),
      kind: Type.Optional(Type.String({ maxLength: 80 })),
      fuzzy: Type.Optional(
        Type.Boolean({
          description: "Use explicit identifier subsequence matching.",
        }),
      ),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runtime = usableRuntime(getRuntime(), ctx.isProjectTrusted());
      if (!runtime) return unavailable();
      try {
        const status = await validate(runtime, signal);
        const symbols = await runtime.worker.searchSymbols({
          query: params.query,
          path: params.path,
          kind: params.kind,
          fuzzy: params.fuzzy,
          limit: params.maxResults ?? runtime.searchMaxResults,
          signal,
        });
        return discoveryResult("Search", symbols, status, runtime.outputStyle);
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "code_outline",
    label: "Code Outline",
    description:
      "Show source-free indexed symbols for one current-project file.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1_024 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runtime = usableRuntime(getRuntime(), ctx.isProjectTrusted());
      if (!runtime) return unavailable();
      try {
        const status = await validate(runtime, signal);
        const symbols = await runtime.worker.fileSymbols(params.path, signal);
        return discoveryResult("Outline", symbols, status, runtime.outputStyle);
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "code_get",
    label: "Get Code",
    description: "Read the current live source span for one indexed symbol.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 128 }),
      tokenBudget: Type.Optional(
        Type.Integer({ minimum: 256, maximum: 16_000 }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runtime = usableRuntime(getRuntime(), ctx.isProjectTrusted());
      if (!runtime) return unavailable();
      try {
        const { status, symbols, sources } = await liveSymbols(
          runtime,
          [params.id],
          signal,
        );
        const symbol = symbols[0];
        const source = symbol ? sources.get(symbol.path) : undefined;
        if (!symbol || !source) return notFound(params.id, status);
        const limitBytes = budgetBytes(
          params.tokenBudget ?? runtime.retrievalTokenBudget,
        );
        const slice = sliceUtf8(
          source.subarray(symbol.startByte, symbol.endByte),
          limitBytes,
        );
        return sourceResult("Code", symbol, slice, status);
      } catch (error) {
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "code_context",
    label: "Code Context",
    description:
      "Read current live source spans for selected indexed symbols under one budget.",
    parameters: Type.Object({
      ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        minItems: 1,
        maxItems: 20,
      }),
      tokenBudget: Type.Optional(
        Type.Integer({ minimum: 256, maximum: 16_000 }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runtime = usableRuntime(getRuntime(), ctx.isProjectTrusted());
      if (!runtime) return unavailable();
      try {
        const { status, symbols, sources } = await liveSymbols(
          runtime,
          params.ids,
          signal,
        );
        const remaining = {
          bytes: budgetBytes(params.tokenBudget ?? runtime.contextTokenBudget),
        };
        const sections: string[] = [];
        const omitted: string[] = [];
        for (const id of params.ids) {
          const symbol = symbols.find((candidate) => candidate.id === id);
          const source = symbol ? sources.get(symbol.path) : undefined;
          if (!symbol || !source) {
            omitted.push(`${id}: not indexed after validation`);
            continue;
          }
          if (remaining.bytes <= 0) {
            omitted.push(`${symbol.qualifiedName}: budget exhausted`);
            continue;
          }
          const slice = sliceUtf8(
            source.subarray(symbol.startByte, symbol.endByte),
            remaining.bytes,
          );
          remaining.bytes -= slice.bytes;
          sections.push(sourceSection(symbol, slice));
          if (slice.truncated)
            omitted.push(`${symbol.qualifiedName}: truncated`);
        }
        const header = evidence("Context", status);
        const notices = omitted.length
          ? `\nOmitted: ${omitted.join("; ")}`
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `${header}\n\n${sections.join("\n\n")}${notices}`,
            },
          ],
          details: { status, returned: sections.length, omitted },
        };
      } catch (error) {
        return failure(error);
      }
    },
  });
}

function usableRuntime(
  runtime: CodeSearchToolRuntime | undefined,
  trusted: boolean,
): CodeSearchToolRuntime | undefined {
  return trusted ? runtime : undefined;
}

async function validate(
  runtime: CodeSearchToolRuntime,
  signal: AbortSignal | undefined,
): Promise<CodeSearchWorkerStatus> {
  return runtime.worker.validate({
    root: runtime.root,
    additionalIgnores: runtime.additionalIgnores,
    signal,
  });
}

async function liveSymbols(
  runtime: CodeSearchToolRuntime,
  ids: string[],
  signal: AbortSignal | undefined,
): Promise<{
  status: CodeSearchWorkerStatus;
  symbols: CodeSearchLocatedSymbol[];
  sources: Map<string, Buffer>;
}> {
  let status = await validate(runtime, signal);
  let symbols = await runtime.worker.symbolsByIds(ids, signal);
  let sources = await readVerifiedSources(runtime, symbols);
  if (!sources) {
    status = await validate(runtime, signal);
    symbols = await runtime.worker.symbolsByIds(ids, signal);
    sources = await readVerifiedSources(runtime, symbols);
  }
  if (!sources)
    throw new Error("Source changed during validation; retry the request.");
  return { status, symbols, sources };
}

async function readVerifiedSources(
  runtime: CodeSearchToolRuntime,
  symbols: CodeSearchLocatedSymbol[],
): Promise<Map<string, Buffer> | undefined> {
  const expected = new Map<string, CodeSearchLocatedSymbol>();
  for (const symbol of symbols) expected.set(symbol.path, symbol);
  const sources = new Map<string, Buffer>();
  for (const [path, symbol] of expected) {
    const absolute = safePath(runtime.root, path);
    const fileStatus = await lstat(absolute);
    if (!fileStatus.isFile() || fileStatus.isSymbolicLink()) return undefined;
    const source = await readFile(absolute);
    if (
      createHash("sha256").update(source).digest("hex") !== symbol.contentHash
    ) {
      return undefined;
    }
    sources.set(path, source);
  }
  return sources;
}

function safePath(root: string, path: string): string {
  if (!path || path.includes("\\") || path.startsWith("/")) {
    throw new Error("Code path is outside the current project root.");
  }
  const absolute = resolve(root, path);
  const relativePath = relative(resolve(root), absolute);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error("Code path is outside the current project root.");
  }
  return absolute;
}

function discoveryResult(
  title: string,
  symbols: CodeSearchSymbol[],
  status: CodeSearchWorkerStatus,
  style: OutputStyle,
) {
  const header = evidence(title, status);
  if (!symbols.length) {
    return {
      content: [
        {
          type: "text" as const,
          text: `${header}\nNo matching indexed symbols.`,
        },
      ],
      details: { status, results: [] },
    };
  }
  const rows = symbols.map((symbol) => formatSymbol(symbol, style));
  return {
    content: [{ type: "text" as const, text: `${header}\n${rows.join("\n")}` }],
    details: { status, results: symbols },
  };
}

function formatSymbol(symbol: CodeSearchSymbol, style: OutputStyle): string {
  const range = `${symbol.startLine}:${symbol.startColumn}-${symbol.endLine}:${symbol.endColumn}`;
  return style === "structured"
    ? `id: ${symbol.id}\nkind: ${symbol.kind}\nname: ${symbol.qualifiedName}\npath: ${symbol.path}\nrange: ${range}\nlanguage: ${symbol.language}${symbol.parseHasError ? "\nparse: error" : ""}\n`
    : `${symbol.kind} ${symbol.qualifiedName} — ${symbol.path}:${range} [${symbol.id}]${symbol.parseHasError ? " parse-error" : ""}`;
}

function sourceResult(
  title: string,
  symbol: CodeSearchSymbol,
  slice: SourceSlice,
  status: CodeSearchWorkerStatus,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${evidence(title, status)}\n\n${sourceSection(symbol, slice)}`,
      },
    ],
    details: { status, id: symbol.id, truncated: slice.truncated },
  };
}

function sourceSection(symbol: CodeSearchSymbol, slice: SourceSlice): string {
  const range = `${symbol.startLine}:${symbol.startColumn}-${symbol.endLine}:${symbol.endColumn}`;
  const notice = slice.truncated
    ? `\n[Truncated at ${slice.bytes} bytes; selected span is ${symbol.endByte - symbol.startByte} bytes.]`
    : "";
  return `${symbol.kind} ${symbol.qualifiedName} — ${symbol.path}:${range}\n\n${slice.content}${notice}`;
}

function evidence(title: string, status: CodeSearchWorkerStatus): string {
  const coverage = status.coverage;
  return `${title}: ${status.freshness}; indexed ${coverage.indexedFiles}; skipped ignored ${coverage.skippedIgnored}, symlink ${coverage.skippedSymlink}, binary ${coverage.skippedBinary}, oversize ${coverage.skippedOversize}, unreadable ${coverage.skippedUnreadable}.`;
}

type SourceSlice = { content: string; bytes: number; truncated: boolean };

function sliceUtf8(source: Buffer, maxBytes: number): SourceSlice {
  let end = Math.min(source.length, maxBytes, MAX_RESULT_BYTES);
  while (end > 0 && end < source.length && isContinuationByte(source[end]!))
    end--;
  if (end === 0 && source.length > 0) end = utf8CodePointLength(source[0]!);
  return {
    content: source.subarray(0, end).toString("utf8"),
    bytes: end,
    truncated: end < source.length,
  };
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

function utf8CodePointLength(byte: number): number {
  if ((byte & 0b1000_0000) === 0) return 1;
  if ((byte & 0b1110_0000) === 0b1100_0000) return 2;
  if ((byte & 0b1111_0000) === 0b1110_0000) return 3;
  return 4;
}

function budgetBytes(tokens: number): number {
  return Math.max(1_024, Math.min(MAX_RESULT_BYTES, Math.floor(tokens) * 4));
}

function unavailable() {
  return {
    content: [
      { type: "text" as const, text: "Code search runtime is not available." },
    ],
    details: { available: false },
    isError: true,
  };
}

function notFound(id: string, status: CodeSearchWorkerStatus) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${evidence("Code", status)}\nNo indexed symbol matches ${id}.`,
      },
    ],
    details: { status, id, found: false },
  };
}

function failure(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Code search failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    details: {},
    isError: true,
  };
}
