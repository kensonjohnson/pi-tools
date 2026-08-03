import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { parentPort } from "node:worker_threads";
import Database from "better-sqlite3";
import ignore from "ignore";
import Parser from "tree-sitter";
import {
  CODE_SEARCH_PROTOCOL_VERSION,
  type CodeSearchCoverage,
  type CodeSearchFile,
  type CodeSearchSymbol,
  type CodeSearchWorkerRequest,
  type CodeSearchWorkerResponse,
  type CodeSearchWorkerStatus,
} from "./worker-protocol.ts";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const WATCH_DEBOUNCE_MS = 150;
const LANGUAGE_BY_EXTENSION: Record<string, LanguageName | undefined> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".go": "go",
};

type LanguageName = "javascript" | "typescript" | "tsx" | "python" | "go";
type TreeNode = {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildren: TreeNode[];
  hasError?: boolean;
  childForFieldName(name: string): TreeNode | null;
};
type ExtractedSymbol = Omit<
  CodeSearchSymbol,
  "id" | "path" | "language" | "parseHasError"
>;
type IndexedRow = {
  path: string;
  language: string;
  content_hash: string;
  size_bytes: number;
  mtime_ms: number;
  line_count: number;
  parse_has_error: number;
  indexed_at_ms: number;
};
type WatchDirectory = { directory: string; frames: IgnoreFrame[] };
type DiscoveryResult = {
  files: CodeSearchFile[];
  symbolsByPath: Map<string, ExtractedSymbol[]>;
  coverage: CodeSearchCoverage;
  watchDirectories: WatchDirectory[];
};
type WatchOptions = {
  root: string;
  additionalIgnores: string;
  maxFileBytes?: number;
};

let database: Database.Database | undefined;
let requestChain = Promise.resolve();
const cancelled = new Set<string>();
const languageCache = new Map<LanguageName, Promise<unknown>>();
let watchOptions: WatchOptions | undefined;
let watchedDirectories: WatchDirectory[] = [];
let watchers: FSWatcher[] = [];
let watchTimer: NodeJS.Timeout | undefined;

function posix(value: string): string {
  return value.split(sep).join("/");
}

function fileExtension(path: string): string {
  return path.slice(path.lastIndexOf("."));
}

function checkCancelled(id: string): void {
  if (cancelled.has(id)) throw new Error("Request cancelled");
}

function secureStorageFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX mode bits.
  }
}

function requireDatabase(): Database.Database {
  if (!database) throw new Error("Code-search worker is not initialized.");
  return database;
}

function emptyCoverage(): CodeSearchCoverage {
  return {
    indexedFiles: 0,
    skippedIgnored: 0,
    skippedSymlink: 0,
    skippedBinary: 0,
    skippedOversize: 0,
    skippedUnreadable: 0,
  };
}

function ensureStore(storagePath: string): void {
  mkdirSync(dirname(storagePath), { recursive: true, mode: 0o700 });
  database = new Database(storagePath);
  database.pragma("busy_timeout = 2000");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS indexed_files (
      path TEXT PRIMARY KEY,
      language TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      line_count INTEGER NOT NULL,
      parse_has_error INTEGER NOT NULL CHECK (parse_has_error IN (0, 1)),
      indexed_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS symbols (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL REFERENCES indexed_files(path) ON DELETE CASCADE,
      language TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_id TEXT REFERENCES symbols(id) ON DELETE CASCADE,
      start_byte INTEGER NOT NULL,
      end_byte INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      parse_has_error INTEGER NOT NULL CHECK (parse_has_error IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS symbols_path_span ON symbols(path, start_byte, end_byte);
    CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS symbols_qualified_name ON symbols(qualified_name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS index_coverage (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      indexed_files INTEGER NOT NULL,
      skipped_ignored INTEGER NOT NULL,
      skipped_symlink INTEGER NOT NULL,
      skipped_binary INTEGER NOT NULL,
      skipped_oversize INTEGER NOT NULL,
      skipped_unreadable INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
  secureStorageFile(storagePath);
  secureStorageFile(`${storagePath}-wal`);
  secureStorageFile(`${storagePath}-shm`);
}

function status(): CodeSearchWorkerStatus {
  const row = database
    ?.prepare("SELECT * FROM index_coverage WHERE id = 1")
    .get() as
    | {
        indexed_files: number;
        skipped_ignored: number;
        skipped_symlink: number;
        skipped_binary: number;
        skipped_oversize: number;
        skipped_unreadable: number;
      }
    | undefined;
  return {
    ready: Boolean(database),
    watching: watchers.length > 0,
    coverage: row
      ? {
          indexedFiles: row.indexed_files,
          skippedIgnored: row.skipped_ignored,
          skippedSymlink: row.skipped_symlink,
          skippedBinary: row.skipped_binary,
          skippedOversize: row.skipped_oversize,
          skippedUnreadable: row.skipped_unreadable,
        }
      : emptyCoverage(),
  };
}

async function addIgnoreFrame(
  directory: string,
  frames: IgnoreFrame[],
): Promise<IgnoreFrame[]> {
  const path = join(directory, ".gitignore");
  try {
    const fileStatus = await lstat(path);
    if (!fileStatus.isFile() || fileStatus.isSymbolicLink()) return frames;
    return [
      ...frames,
      {
        directory,
        matcher: ignore({ ignoreCase: false }).add(
          await readFile(path, "utf8"),
        ),
      },
    ];
  } catch {
    // An unreadable ignore file never becomes index data; retain inherited rules.
    return frames;
  }
}

type IgnoreFrame = { directory: string; matcher: ReturnType<typeof ignore> };

function isGitIgnored(
  absolute: string,
  isDirectory: boolean,
  frames: IgnoreFrame[],
): boolean {
  let included = true;
  for (const frame of frames) {
    const path = `${posix(relative(frame.directory, absolute))}${isDirectory ? "/" : ""}`;
    const result = frame.matcher.test(path);
    if (result.ignored) included = false;
    if (result.unignored) included = true;
  }
  return !included;
}

function configuredIgnore(patterns: string): ReturnType<typeof ignore> {
  const values = patterns
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    values.some(
      (value) =>
        value.startsWith("!") ||
        value.startsWith("/") ||
        value.includes("..") ||
        value.includes("\\"),
    )
  ) {
    throw new Error(
      "Configured code-search ignores must be non-negated root-relative paths.",
    );
  }
  return ignore({ ignoreCase: false }).add(values);
}

async function languageFor(language: LanguageName): Promise<unknown> {
  let loaded = languageCache.get(language);
  if (!loaded) {
    loaded = (async () => {
      if (language === "javascript")
        return (await import("tree-sitter-javascript")).default;
      if (language === "python")
        return (await import("tree-sitter-python")).default;
      if (language === "go") return (await import("tree-sitter-go")).default;
      const typescript = (await import("tree-sitter-typescript")).default as {
        typescript: unknown;
        tsx: unknown;
      };
      return language === "tsx" ? typescript.tsx : typescript.typescript;
    })();
    languageCache.set(language, loaded);
  }
  return loaded;
}

async function discover(
  request: Extract<CodeSearchWorkerRequest, { type: "refresh" | "validate" }>,
): Promise<DiscoveryResult> {
  const root = request.root;
  const configured = configuredIgnore(request.additionalIgnores);
  const knownFiles = new Map<string, IndexedRow>();
  for (const row of requireDatabase()
    .prepare("SELECT * FROM indexed_files")
    .all() as IndexedRow[]) {
    knownFiles.set(row.path, row);
  }
  const result: DiscoveryResult = {
    files: [],
    symbolsByPath: new Map(),
    coverage: emptyCoverage(),
    watchDirectories: [],
  };
  const visit = async (
    directory: string,
    frames: IgnoreFrame[],
  ): Promise<void> => {
    checkCancelled(request.id);
    const nextFrames = await addIgnoreFrame(directory, frames);
    result.watchDirectories.push({ directory, frames: nextFrames });
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      result.coverage.skippedUnreadable++;
      return;
    }
    for (const entry of entries) {
      checkCancelled(request.id);
      if (entry === ".git" || entry === ".pi" || entry === ".gitignore")
        continue;
      const absolute = join(directory, entry);
      let fileStatus;
      try {
        fileStatus = await lstat(absolute);
      } catch {
        result.coverage.skippedUnreadable++;
        continue;
      }
      if (fileStatus.isSymbolicLink()) {
        result.coverage.skippedSymlink++;
        continue;
      }
      const path = posix(relative(root, absolute));
      const ignoredPath = `${path}${fileStatus.isDirectory() ? "/" : ""}`;
      if (
        configured.ignores(ignoredPath) ||
        isGitIgnored(absolute, fileStatus.isDirectory(), nextFrames)
      ) {
        result.coverage.skippedIgnored++;
        continue;
      }
      if (fileStatus.isDirectory()) {
        await visit(absolute, nextFrames);
        continue;
      }
      const language = LANGUAGE_BY_EXTENSION[fileExtension(entry)];
      if (!fileStatus.isFile() || !language) continue;
      if (fileStatus.size > (request.maxFileBytes ?? MAX_FILE_BYTES)) {
        result.coverage.skippedOversize++;
        continue;
      }
      let source: Buffer;
      try {
        source = await readFile(absolute);
      } catch {
        result.coverage.skippedUnreadable++;
        continue;
      }
      if (source.subarray(0, 8192).includes(0)) {
        result.coverage.skippedBinary++;
        continue;
      }
      const contentHash = createHash("sha256").update(source).digest("hex");
      const known = knownFiles.get(path);
      const unchanged = known?.content_hash === contentHash;
      const text = source.toString("utf8");
      let parseHasError = known?.parse_has_error === 1;
      if (!unchanged) {
        const parser = new Parser();
        parser.setLanguage((await languageFor(language)) as never);
        const rootNode = parser.parse(text).rootNode as unknown as TreeNode;
        parseHasError = Boolean(rootNode.hasError);
        result.symbolsByPath.set(
          path,
          extractSymbols(rootNode, text, language, path),
        );
      }
      result.files.push({
        path,
        language,
        contentHash,
        sizeBytes: fileStatus.size,
        mtimeMs: Math.floor(fileStatus.mtimeMs),
        lineCount: text.split("\n").length,
        parseHasError,
        indexedAtMs: 0,
      });
    }
  };
  await visit(root, []);
  return result;
}

async function refresh(
  request: Extract<CodeSearchWorkerRequest, { type: "refresh" | "validate" }>,
): Promise<CodeSearchWorkerStatus> {
  const discovered = await discover(request);
  checkCancelled(request.id);
  const now = Date.now();
  const db = requireDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const upsertFile = db.prepare(`
      INSERT INTO indexed_files (
        path, language, content_hash, size_bytes, mtime_ms, line_count,
        parse_has_error, indexed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        language = excluded.language,
        content_hash = excluded.content_hash,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        line_count = excluded.line_count,
        parse_has_error = excluded.parse_has_error,
        indexed_at_ms = excluded.indexed_at_ms
    `);
    const deleteSymbols = db.prepare("DELETE FROM symbols WHERE path = ?");
    const insertSymbol = db.prepare(`
      INSERT INTO symbols (
        id, path, language, name, qualified_name, kind, parent_id,
        start_byte, end_byte, start_line, start_column, end_line, end_column,
        parse_has_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const file of discovered.files) {
      upsertFile.run(
        file.path,
        file.language,
        file.contentHash,
        file.sizeBytes,
        file.mtimeMs,
        file.lineCount,
        file.parseHasError ? 1 : 0,
        now,
      );
      const symbols = discovered.symbolsByPath.get(file.path);
      if (!symbols) continue;
      deleteSymbols.run(file.path);
      for (const symbol of symbols) {
        const id = stableSymbolId(file.path, symbol);
        insertSymbol.run(
          id,
          file.path,
          file.language,
          symbol.name,
          symbol.qualifiedName,
          symbol.kind,
          symbol.parentId ?? null,
          symbol.startByte,
          symbol.endByte,
          symbol.startLine,
          symbol.startColumn,
          symbol.endLine,
          symbol.endColumn,
          file.parseHasError ? 1 : 0,
        );
      }
    }
    db.prepare("DELETE FROM indexed_files WHERE indexed_at_ms != ?").run(now);
    db.prepare(
      `
      INSERT INTO index_coverage VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        indexed_files = excluded.indexed_files,
        skipped_ignored = excluded.skipped_ignored,
        skipped_symlink = excluded.skipped_symlink,
        skipped_binary = excluded.skipped_binary,
        skipped_oversize = excluded.skipped_oversize,
        skipped_unreadable = excluded.skipped_unreadable,
        updated_at_ms = excluded.updated_at_ms
    `,
    ).run(
      discovered.files.length,
      discovered.coverage.skippedIgnored,
      discovered.coverage.skippedSymlink,
      discovered.coverage.skippedBinary,
      discovered.coverage.skippedOversize,
      discovered.coverage.skippedUnreadable,
      now,
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite may already have rolled the failed transaction back.
    }
    throw error;
  }
  watchedDirectories = discovered.watchDirectories;
  if (watchOptions) rebuildWatchers(watchedDirectories);
  secureStorageFile(db.name);
  secureStorageFile(`${db.name}-wal`);
  secureStorageFile(`${db.name}-shm`);
  return status();
}

function extractSymbols(
  root: TreeNode,
  source: string,
  language: LanguageName,
  path: string,
): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const walk = (node: TreeNode, parent?: ExtractedSymbol): void => {
    const candidate = symbolForNode(node, source, language, path, parent);
    if (candidate) symbols.push(candidate);
    const nextParent = candidate ?? parent;
    for (const child of node.namedChildren) walk(child, nextParent);
  };
  walk(root);
  return symbols;
}

function symbolForNode(
  node: TreeNode,
  source: string,
  language: LanguageName,
  path: string,
  parent: ExtractedSymbol | undefined,
): ExtractedSymbol | undefined {
  const kind = symbolKind(node, language);
  if (!kind) return undefined;
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return undefined;
  const name = source.slice(nameNode.startIndex, nameNode.endIndex).trim();
  if (!name) return undefined;
  const qualifiedName = parent ? `${parent.qualifiedName}.${name}` : name;
  return {
    name,
    qualifiedName,
    kind,
    parentId: parent ? stableSymbolId(path, parent) : undefined,
    startByte: node.startIndex,
    endByte: node.endIndex,
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

function symbolKind(
  node: TreeNode,
  language: LanguageName,
): string | undefined {
  const { type } = node;
  if (language === "python") {
    if (type === "function_definition") return "function";
    if (type === "class_definition") return "class";
    return undefined;
  }
  if (language === "go") {
    if (type === "function_declaration" || type === "method_declaration")
      return "function";
    if (type === "type_spec") return "type";
    if (type === "var_spec") return "variable";
    if (type === "const_spec") return "constant";
    return undefined;
  }
  if (
    type === "function_declaration" ||
    type === "generator_function_declaration" ||
    type === "method_definition" ||
    type === "arrow_function"
  ) {
    return "function";
  }
  if (type === "class_declaration" || type === "abstract_class_declaration")
    return "class";
  if (type === "interface_declaration") return "interface";
  if (type === "enum_declaration") return "enum";
  if (type === "type_alias_declaration") return "type";
  if (type === "variable_declarator") {
    return node.namedChildren.some(
      (child) =>
        child.type === "arrow_function" || child.type === "function_expression",
    )
      ? "function"
      : "variable";
  }
  if (type === "public_field_definition") return "field";
  return undefined;
}

function stableSymbolId(path: string, symbol: ExtractedSymbol): string {
  return createHash("sha256")
    .update(path)
    .update("\0")
    .update(symbol.qualifiedName)
    .update("\0")
    .update(symbol.kind)
    .update("\0")
    .update(String(symbol.startByte))
    .digest("hex");
}

function symbolsForQuery(
  query: string,
  limit: number,
  path?: string,
  kind?: string,
): CodeSearchSymbol[] {
  const clauses = [
    "(name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\')",
  ];
  const escaped = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const parameters: Array<string | number> = [escaped, escaped];
  if (path) {
    clauses.push("path = ?");
    parameters.push(path);
  }
  if (kind) {
    clauses.push("kind = ?");
    parameters.push(kind);
  }
  parameters.push(Math.max(1, Math.min(100, Math.floor(limit))));
  const rows = requireDatabase()
    .prepare(
      `
      SELECT id, path, language, name, qualified_name, kind, parent_id,
             start_byte, end_byte, start_line, start_column, end_line, end_column,
             parse_has_error
      FROM symbols WHERE ${clauses.join(" AND ")}
      ORDER BY CASE WHEN name = ? THEN 0 WHEN qualified_name = ? THEN 1 ELSE 2 END,
               length(qualified_name), path, start_byte
      LIMIT ?
    `,
    )
    .all(
      ...parameters.slice(0, -1),
      query,
      query,
      parameters.at(-1),
    ) as SymbolRow[];
  return rows.map(symbolRow);
}

type SymbolRow = {
  id: string;
  path: string;
  language: string;
  name: string;
  qualified_name: string;
  kind: string;
  parent_id: string | null;
  start_byte: number;
  end_byte: number;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  parse_has_error: number;
};

function symbolRow(row: SymbolRow): CodeSearchSymbol {
  return {
    id: row.id,
    path: row.path,
    language: row.language,
    name: row.name,
    qualifiedName: row.qualified_name,
    kind: row.kind,
    parentId: row.parent_id ?? undefined,
    startByte: row.start_byte,
    endByte: row.end_byte,
    startLine: row.start_line,
    startColumn: row.start_column,
    endLine: row.end_line,
    endColumn: row.end_column,
    parseHasError: row.parse_has_error === 1,
  };
}

function fileSymbols(path: string): CodeSearchSymbol[] {
  const rows = requireDatabase()
    .prepare(
      `
      SELECT id, path, language, name, qualified_name, kind, parent_id,
             start_byte, end_byte, start_line, start_column, end_line, end_column,
             parse_has_error
      FROM symbols WHERE path = ? ORDER BY start_byte, end_byte, name
    `,
    )
    .all(path) as SymbolRow[];
  return rows.map(symbolRow);
}

function clearWatchers(): void {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = undefined;
  for (const watcher of watchers) watcher.close();
  watchers = [];
}

function rebuildWatchers(directories: WatchDirectory[]): void {
  clearWatchers();
  const configured = watchOptions
    ? configuredIgnore(watchOptions.additionalIgnores)
    : undefined;
  for (const { directory, frames } of directories) {
    try {
      const watcher = watch(
        directory,
        { persistent: false },
        (_event, filename) => {
          const changed = filename?.toString();
          if (!changed || changed === ".gitignore") {
            scheduleWatchRefresh();
            return;
          }
          if (
            changed === ".git" ||
            changed === ".pi" ||
            changed.startsWith(".pi/")
          )
            return;
          const absolute = join(directory, changed);
          const rootPath = posix(relative(watchOptions!.root, absolute));
          if (
            configured?.ignores(rootPath) ||
            configured?.ignores(`${rootPath}/`) ||
            isGitIgnored(absolute, false, frames) ||
            isGitIgnored(absolute, true, frames)
          )
            return;
          scheduleWatchRefresh();
        },
      );
      watcher.on("error", () => {});
      watchers.push(watcher);
    } catch {
      // A watcher is an optional acceleration and never establishes freshness.
    }
  }
}

function scheduleWatchRefresh(): void {
  if (!watchOptions || watchTimer) return;
  watchTimer = setTimeout(() => {
    watchTimer = undefined;
    const options = watchOptions;
    if (!options || !database) return;
    const request: Extract<CodeSearchWorkerRequest, { type: "refresh" }> = {
      version: CODE_SEARCH_PROTOCOL_VERSION,
      id: `watch-${Date.now()}`,
      type: "refresh",
      ...options,
    };
    requestChain = requestChain.then(() => refresh(request)).catch(() => {});
  }, WATCH_DEBOUNCE_MS);
}

async function handle(
  request: Exclude<CodeSearchWorkerRequest, { type: "cancel" }>,
): Promise<CodeSearchWorkerStatus | CodeSearchSymbol[] | { closed: true }> {
  if (request.type === "initialize") {
    ensureStore(request.storagePath);
    return status();
  }
  if (request.type === "status") return status();
  if (request.type === "refresh" || request.type === "validate")
    return refresh(request);
  if (request.type === "watch") {
    clearWatchers();
    watchOptions = request.enabled
      ? {
          root: request.root,
          additionalIgnores: request.additionalIgnores,
          maxFileBytes: request.maxFileBytes,
        }
      : undefined;
    if (watchOptions) rebuildWatchers(watchedDirectories);
    return status();
  }
  if (request.type === "searchSymbols") {
    checkCancelled(request.id);
    return symbolsForQuery(
      request.query,
      request.limit,
      request.path,
      request.kind,
    );
  }
  if (request.type === "fileSymbols") {
    checkCancelled(request.id);
    return fileSymbols(request.path);
  }
  if (request.type === "close") {
    watchOptions = undefined;
    watchedDirectories = [];
    clearWatchers();
    database?.close();
    database = undefined;
    return { closed: true };
  }
  throw new Error(
    `Unsupported code-search worker request: ${(request as { type: string }).type}`,
  );
}

function post(response: CodeSearchWorkerResponse): void {
  parentPort?.postMessage(response);
}

parentPort?.on("message", (value: unknown) => {
  const request = value as CodeSearchWorkerRequest;
  if (request?.version !== CODE_SEARCH_PROTOCOL_VERSION) return;
  if (request.type === "cancel") {
    cancelled.add(request.requestId);
    return;
  }
  requestChain = requestChain.then(async () => {
    try {
      const result = await handle(request);
      post({
        version: CODE_SEARCH_PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        result,
      });
    } catch (error) {
      post({
        version: CODE_SEARCH_PROTOCOL_VERSION,
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      cancelled.delete(request.id);
    }
  });
});
