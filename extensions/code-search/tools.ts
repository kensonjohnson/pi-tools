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
import {
  searchLiteralText,
  type LiteralTextMatch,
  type LiteralTextSearchResult,
} from "./literal-search.ts";
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
      tokenBudget: Type.Optional(
        Type.Integer({ minimum: 128, maximum: 8_000 }),
      ),
      text: Type.Optional(
        Type.Boolean({
          description:
            "Explicitly run transient fixed-string text fallback without returning source text.",
        }),
      ),
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
        const text = params.text
          ? await searchLiteralText({
              root: runtime.root,
              paths: await runtime.worker.eligibleTextPaths({
                root: runtime.root,
                additionalIgnores: runtime.additionalIgnores,
                signal,
              }),
              query: params.query,
              limit: Math.max(
                1,
                (params.maxResults ?? runtime.searchMaxResults) -
                  symbols.length,
              ),
              signal,
            })
          : undefined;
        return discoveryResult(
          "Search",
          symbols,
          status,
          runtime.outputStyle,
          params.tokenBudget ?? runtime.searchTokenBudget,
          text,
        );
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
      tokenBudget: Type.Optional(
        Type.Integer({ minimum: 128, maximum: 8_000 }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runtime = usableRuntime(getRuntime(), ctx.isProjectTrusted());
      if (!runtime) return unavailable();
      try {
        const status = await validate(runtime, signal);
        const symbols = await runtime.worker.fileSymbols(params.path, signal);
        return discoveryResult(
          "Outline",
          symbols,
          status,
          runtime.outputStyle,
          params.tokenBudget ?? runtime.searchTokenBudget,
        );
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
        return sourceResult(
          "Code",
          symbol,
          source,
          status,
          params.tokenBudget ?? runtime.retrievalTokenBudget,
        );
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
        const omitted: string[] = [];
        const parentSymbols = await ancestors(runtime, symbols, signal);
        const parentSources = await readVerifiedSources(runtime, parentSymbols);
        if (parentSymbols.length && !parentSources) {
          omitted.push(
            "containing headers: source changed during verification",
          );
        }
        const header = evidence("Context", status);
        const response = new BudgetedResponse(
          header,
          budgetBytes(params.tokenBudget ?? runtime.contextTokenBudget),
        );
        let targetOmitted = false;
        for (const id of params.ids) {
          const symbol = symbols.find((candidate) => candidate.id === id);
          const source = symbol ? sources.get(symbol.path) : undefined;
          if (!symbol || !source) {
            targetOmitted = true;
            omitted.push(`${id}: not indexed after validation`);
            continue;
          }
          const result = response.addSource(symbol, source);
          if (result === "omitted") {
            targetOmitted = true;
            omitted.push(`${symbol.qualifiedName}: budget exhausted`);
          }
          if (result === "truncated")
            omitted.push(`${symbol.qualifiedName}: truncated`);
        }
        if (!targetOmitted) {
          for (const statement of importStatements(sources.values())) {
            if (!response.add(`Import\n${statement}`)) {
              omitted.push("imports: budget exhausted");
              break;
            }
          }
        } else {
          omitted.push("imports: selected target budget priority");
        }
        if (parentSources && !targetOmitted) {
          for (const parent of parentSymbols) {
            const source = parentSources.get(parent.path);
            if (!source) continue;
            if (
              !response.add(
                `Containing header\n${declarationHeader(parent, source)}`,
              )
            ) {
              omitted.push("containing headers: budget exhausted");
              break;
            }
          }
        }
        response.addOmissionNotice(omitted);
        return {
          content: [{ type: "text" as const, text: response.text() }],
          details: { status, returned: response.sections, omitted },
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

async function ancestors(
  runtime: CodeSearchToolRuntime,
  selected: CodeSearchLocatedSymbol[],
  signal: AbortSignal | undefined,
): Promise<CodeSearchLocatedSymbol[]> {
  const selectedIds = new Set(selected.map((symbol) => symbol.id));
  const seen = new Set(selectedIds);
  const result: CodeSearchLocatedSymbol[] = [];
  let pending = selected.flatMap((symbol) =>
    symbol.parentId ? [symbol.parentId] : [],
  );
  for (let depth = 0; pending.length && depth < 20; depth++) {
    const ids = [...new Set(pending)].filter((id) => !seen.has(id));
    if (!ids.length) break;
    ids.forEach((id) => seen.add(id));
    const found = await runtime.worker.symbolsByIds(ids, signal);
    result.push(...found);
    pending = found.flatMap((symbol) =>
      symbol.parentId && !selectedIds.has(symbol.parentId)
        ? [symbol.parentId]
        : [],
    );
  }
  return result;
}

class BudgetedResponse {
  readonly #parts: string[] = [];
  #bytes: number;
  readonly #header: string;
  readonly #limit: number;

  constructor(header: string, limit: number) {
    this.#header = header;
    this.#limit = limit;
    this.#bytes = Buffer.byteLength(this.#header);
  }

  get sections(): number {
    return this.#parts.length;
  }

  add(content: string): boolean {
    const separator = this.#parts.length ? "\n\n" : "\n\n";
    const bytes = Buffer.byteLength(separator) + Buffer.byteLength(content);
    if (this.#bytes + bytes > this.#limit) return false;
    this.#parts.push(content);
    this.#bytes += bytes;
    return true;
  }

  addOmissionNotice(omitted: string[]): void {
    if (!omitted.length) return;
    if (this.add(`Omitted: ${omitted.join("; ")}`)) return;
    this.add(`Omitted: ${omitted.length}; target budget priority.`);
  }

  addSource(
    symbol: CodeSearchSymbol,
    source: Buffer,
  ): "full" | "truncated" | "omitted" {
    const separatorBytes = Buffer.byteLength("\n\n");
    const label = sourceLabel(symbol);
    const labelBytes = Buffer.byteLength(label);
    if (this.#bytes + separatorBytes + labelBytes >= this.#limit) {
      return "omitted";
    }
    let slice = sliceUtf8(
      source.subarray(symbol.startByte, symbol.endByte),
      Math.max(
        0,
        this.#limit - this.#bytes - separatorBytes - labelBytes - 128,
      ),
    );
    let content = `${label}${slice.content}${slice.truncated ? truncationNotice(symbol, slice) : ""}`;
    while (
      this.#bytes + separatorBytes + Buffer.byteLength(content) > this.#limit &&
      slice.bytes > 0
    ) {
      slice = sliceUtf8(
        source.subarray(symbol.startByte, symbol.endByte),
        slice.bytes - 1,
      );
      content = `${label}${slice.content}${slice.truncated ? truncationNotice(symbol, slice) : ""}`;
    }
    if (!this.add(content)) return "omitted";
    return slice.truncated ? "truncated" : "full";
  }

  text(): string {
    return `${this.#header}${this.#parts.length ? `\n\n${this.#parts.join("\n\n")}` : ""}`;
  }
}

function importStatements(sources: Iterable<Buffer>): string[] {
  const statements = new Set<string>();
  for (const source of sources) {
    const text = source.toString("utf8");
    const patterns = [
      /^\s*import(?:[\s\S]*?\bfrom\s*)?["'][^"'\n]+["']\s*;?\s*$/gm,
      /^\s*(?:from\s+[^\n]+\s+import\s+[^\n]+|import\s+[^\n]+)\s*$/gm,
      /^\s*import\s*\([\s\S]*?^\s*\)\s*$/gm,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const statement = match[0].trim();
        if (statement) statements.add(statement);
      }
    }
  }
  return [...statements].sort();
}

function declarationHeader(symbol: CodeSearchSymbol, source: Buffer): string {
  const declaration = sliceUtf8(
    source.subarray(symbol.startByte, symbol.endByte),
    1_024,
  ).content;
  const firstLine = declaration.split(/\r?\n/, 1)[0] ?? "";
  const end = firstLine.search(/[{:]/);
  const signature = (
    end >= 0 ? firstLine.slice(0, end + 1) : firstLine
  ).trimEnd();
  return `${symbol.kind} ${symbol.qualifiedName} — ${symbol.path}:${symbol.startLine}\n${signature}`;
}

function sourceLabel(symbol: CodeSearchSymbol): string {
  const range = `${symbol.startLine}:${symbol.startColumn}-${symbol.endLine}:${symbol.endColumn}`;
  return `${symbol.kind} ${symbol.qualifiedName} — ${symbol.path}:${range}${symbol.parseHasError ? " [parse-error]" : ""}\n\n`;
}

function truncationNotice(
  symbol: CodeSearchSymbol,
  slice: SourceSlice,
): string {
  return `\n[Truncated at ${slice.bytes} bytes; selected span is ${symbol.endByte - symbol.startByte} bytes.]`;
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
  tokenBudget: number,
  text?: LiteralTextSearchResult,
) {
  const header = evidence(title, status);
  if (!symbols.length && !text?.matches.length) {
    const fallback = text?.unavailable
      ? `\nText fallback unavailable: ${text.unavailable}`
      : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `${header}\nNo matching indexed symbols.${fallback}`,
        },
      ],
      details: { status, results: [], textMatches: text?.matches ?? [] },
    };
  }
  const entries: Array<CodeSearchSymbol | LiteralTextMatch> = [
    ...symbols,
    ...(text?.matches ?? []),
  ];
  const limit = budgetBytes(tokenBudget);
  const rows: string[] = [];
  let bytes = Buffer.byteLength(header);
  for (const entry of entries) {
    const row =
      "id" in entry
        ? formatSymbol(entry, style)
        : formatTextMatch(entry, style);
    // Keep room for an explicit notice: a budget must never silently change
    // the discovered set.
    if (bytes + Buffer.byteLength("\n\n") + Buffer.byteLength(row) + 96 > limit)
      break;
    rows.push(row);
    bytes += Buffer.byteLength("\n\n") + Buffer.byteLength(row);
  }
  const omitted = entries.length - rows.length;
  const notices = [
    omitted
      ? `Results omitted: ${omitted}; token budget exhausted.`
      : undefined,
    text?.limited
      ? "Text matches omitted: result/output limit reached."
      : undefined,
    text?.unavailable
      ? `Text fallback unavailable: ${text.unavailable}`
      : undefined,
  ].filter((notice): notice is string => Boolean(notice));
  const notice = notices.length ? `\n\n${notices.join("\n")}` : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `${header}\n\n${rows.join("\n\n")}${notice}`,
      },
    ],
    details: {
      status,
      results: symbols.slice(0, Math.min(symbols.length, rows.length)),
      textMatches: text?.matches ?? [],
      omitted,
      textFallback: text
        ? { limited: text.limited, unavailable: text.unavailable }
        : undefined,
    },
  };
}

function formatTextMatch(match: LiteralTextMatch, style: OutputStyle): string {
  const range = `${match.line}:${match.startColumn}-${match.line}:${match.endColumn}`;
  return style === "structured"
    ? `match: literal-text\npath: ${match.path}\nrange: ${range}\n`
    : `literal-text — ${match.path}:${range}`;
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
  source: Buffer,
  status: CodeSearchWorkerStatus,
  tokenBudget: number,
) {
  const response = new BudgetedResponse(
    evidence(title, status),
    budgetBytes(tokenBudget),
  );
  const result = response.addSource(symbol, source);
  const notice =
    result === "omitted"
      ? "\n\nOmitted: selected symbol header exceeds the token budget."
      : "";
  return {
    content: [{ type: "text" as const, text: `${response.text()}${notice}` }],
    details: { status, id: symbol.id, truncated: result === "truncated" },
  };
}

function sourceSection(symbol: CodeSearchSymbol, slice: SourceSlice): string {
  return `${sourceLabel(symbol)}${slice.content}${slice.truncated ? truncationNotice(symbol, slice) : ""}`;
}

function evidence(title: string, status: CodeSearchWorkerStatus): string {
  const coverage = status.coverage;
  return `${title}: ${status.freshness}; indexed ${coverage.indexedFiles}; AST parse errors ${coverage.parseErrors}; skipped ignored ${coverage.skippedIgnored}, symlink ${coverage.skippedSymlink}, binary ${coverage.skippedBinary}, oversize ${coverage.skippedOversize}, unreadable ${coverage.skippedUnreadable}.`;
}

type SourceSlice = { content: string; bytes: number; truncated: boolean };

function sliceUtf8(source: Buffer, maxBytes: number): SourceSlice {
  if (maxBytes <= 0) {
    return { content: "", bytes: 0, truncated: source.length > 0 };
  }
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
