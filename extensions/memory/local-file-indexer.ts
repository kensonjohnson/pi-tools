import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { SQLiteFileChunkStore, FileChunkRecord } from "./file-index-store.ts";

export interface EmbeddingProvider {
  name(): string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface LocalFileIndexerOptions {
  cwd: string;
  chunkSizeLines: number;
  overlapLines: number;
  maxFileSizeBytes: number;
  excludeDirs: string[];
  embeddingProvider: EmbeddingProvider | null;
  semanticEnabled: boolean;
  indexVector(itemId: string, vector: number[]): void;
  removeVector(itemId: string): void;
  onSemanticFailure(): void;
}

export interface SyncLocalFilesOptions {
  roots?: string[];
  paths?: string[];
  force?: boolean;
}

export interface FileIndexResult {
  indexedFiles: number;
  skippedFiles: number;
  removedFiles: number;
  chunksIndexed: number;
}

interface ScopeTarget {
  absolutePath: string;
  relativePath: string;
  kind: "file" | "directory" | "missing";
}

function stableId(parts: string[]): string {
  return createHash("sha1").update(parts.join("::")).digest("hex");
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function looksBinary(buffer: Buffer): boolean {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

function chunkText(
  text: string,
  chunkSizeLines: number,
  overlapLines: number,
): Array<{
  chunkIndex: number;
  startLine: number;
  endLine: number;
  content: string;
}> {
  const lines = text.split(/\r?\n/);
  const chunks: Array<{
    chunkIndex: number;
    startLine: number;
    endLine: number;
    content: string;
  }> = [];

  const step = Math.max(1, chunkSizeLines - overlapLines);
  for (
    let start = 0, chunkIndex = 0;
    start < lines.length;
    start += step, chunkIndex++
  ) {
    const slice = lines.slice(start, start + chunkSizeLines);
    const content = slice.join("\n").trim();
    if (!content) {
      continue;
    }
    chunks.push({
      chunkIndex,
      startLine: start + 1,
      endLine: start + slice.length,
      content,
    });

    if (start + chunkSizeLines >= lines.length) {
      break;
    }
  }

  return chunks;
}

function isWithinCwd(cwd: string, absolutePath: string): boolean {
  const relativePath = relative(cwd, absolutePath);
  return relativePath !== "" && !relativePath.startsWith("..");
}

export class LocalFileIndexer {
  private semanticEnabled: boolean;
  private embeddingProvider: EmbeddingProvider | null;

  constructor(
    private store: SQLiteFileChunkStore,
    private options: LocalFileIndexerOptions,
  ) {
    this.semanticEnabled = options.semanticEnabled;
    this.embeddingProvider = options.embeddingProvider;
  }

  setSemanticEnabled(enabled: boolean): void {
    this.semanticEnabled = enabled;
  }

  setEmbeddingProvider(provider: EmbeddingProvider | null): void {
    this.embeddingProvider = provider;
  }

  async sync(options: SyncLocalFilesOptions = {}): Promise<FileIndexResult> {
    const targets = await this.resolveTargets(options);
    let indexedFiles = 0;
    let skippedFiles = 0;
    let removedFiles = 0;
    let chunksIndexed = 0;

    for (const target of targets) {
      const seen = new Set<string>();
      if (target.kind !== "missing") {
        const files = await this.collectFiles(target.absolutePath);
        for (const absolutePath of files) {
          const result = await this.indexFile(absolutePath, options.force ?? false);
          if (!result) {
            continue;
          }

          if (result.indexed) {
            indexedFiles++;
            chunksIndexed += result.chunksIndexed;
          } else if (result.removed) {
            removedFiles++;
          } else {
            skippedFiles++;
          }

          seen.add(result.relativePath);
        }
      }

      const stalePaths = this.store.listTrackedPaths(
        this.options.cwd,
        target.relativePath || undefined,
      );
      for (const path of stalePaths) {
        if (seen.has(path)) {
          continue;
        }
        const removed = this.store.deleteFileChunksUnderPath(this.options.cwd, path);
        if (removed.length > 0) {
          for (const row of removed) {
            this.options.removeVector(`file:${row.id}`);
          }
          removedFiles++;
        }
      }

    }

    return {
      indexedFiles,
      skippedFiles,
      removedFiles,
      chunksIndexed,
    };
  }

  private async resolveTargets(
    options: SyncLocalFilesOptions,
  ): Promise<ScopeTarget[]> {
    const targets = options.paths?.length ? options.paths : options.roots?.length ? options.roots : [this.options.cwd];
    const resolved: ScopeTarget[] = [];

    for (const entry of targets) {
      const absolutePath = resolve(this.options.cwd, entry);
      const relativePath = normalizePath(relative(this.options.cwd, absolutePath));
      const exists = await access(absolutePath)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        resolved.push({
          absolutePath,
          relativePath,
          kind: "missing",
        });
        continue;
      }

      const stats = await stat(absolutePath);
      resolved.push({
        absolutePath,
        relativePath,
        kind: stats.isDirectory() ? "directory" : "file",
      });
    }

    return resolved;
  }

  private async collectFiles(rootPath: string): Promise<string[]> {
    const stats = await stat(rootPath);
    if (stats.isFile()) {
      return isWithinCwd(this.options.cwd, rootPath) ? [rootPath] : [];
    }

    if (!stats.isDirectory()) {
      return [];
    }

    const entries = await readdir(rootPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const path = join(rootPath, entry.name);
      if (entry.isDirectory()) {
        if (this.options.excludeDirs.includes(entry.name)) {
          continue;
        }
        files.push(...(await this.collectFiles(path)));
        continue;
      }

      if (entry.isFile() && isWithinCwd(this.options.cwd, path)) {
        files.push(path);
      }
    }

    return files;
  }

  private async indexFile(
    absolutePath: string,
    force: boolean,
  ): Promise<
    | { indexed: true; chunksIndexed: number; relativePath: string; removed: false }
    | { indexed: false; chunksIndexed: 0; relativePath: string; removed: boolean }
    | null
  > {
    const stats = await stat(absolutePath);
    if (!stats.isFile() || stats.size > this.options.maxFileSizeBytes) {
      const relativePath = normalizePath(relative(this.options.cwd, absolutePath));
      const removed = this.store.deleteFileChunksUnderPath(
        this.options.cwd,
        relativePath || undefined,
      );
      if (removed.length > 0) {
        for (const row of removed) {
          this.options.removeVector(`file:${row.id}`);
        }
      }
      return {
        indexed: false,
        chunksIndexed: 0,
        relativePath,
        removed: removed.length > 0,
      };
    }

    const buffer = await readFile(absolutePath);
    const relativePath = normalizePath(relative(this.options.cwd, absolutePath));
    if (looksBinary(buffer)) {
      const removed = this.store.deleteFileChunksUnderPath(
        this.options.cwd,
        relativePath || undefined,
      );
      if (removed.length > 0) {
        for (const row of removed) {
          this.options.removeVector(`file:${row.id}`);
        }
      }
      return {
        indexed: false,
        chunksIndexed: 0,
        relativePath,
        removed: removed.length > 0,
      };
    }

    const content = buffer.toString("utf8");
    if (!content.trim()) {
      const removed = this.store.deleteFileChunksUnderPath(
        this.options.cwd,
        relativePath || undefined,
      );
      if (removed.length > 0) {
        for (const row of removed) {
          this.options.removeVector(`file:${row.id}`);
        }
      }
      return {
        indexed: false,
        chunksIndexed: 0,
        relativePath,
        removed: removed.length > 0,
      };
    }

    const fileHash = createHash("sha256").update(content).digest("hex");
    const existing = this.store.listFileChunks(this.options.cwd, relativePath);
    if (
      !force &&
      existing.length > 0 &&
      existing[0].fileHash === fileHash &&
      existing[0].fileMtimeMs === stats.mtimeMs
    ) {
      return {
        indexed: false,
        chunksIndexed: 0,
        relativePath,
      };
    }

    if (existing.length > 0) {
      const removed = this.store.deleteFileChunksUnderPath(this.options.cwd, relativePath);
      for (const row of removed) {
        this.options.removeVector(`file:${row.id}`);
      }
    }

    const chunks = chunkText(
      content,
      this.options.chunkSizeLines,
      this.options.overlapLines,
    );
    if (chunks.length === 0) {
      return null;
    }

    const now = new Date().toISOString();
    const rows: FileChunkRecord[] = chunks.map((chunk) => ({
      id: stableId([relativePath, String(chunk.chunkIndex)]),
      rootPath: this.options.cwd,
      path: relativePath,
      chunkIndex: chunk.chunkIndex,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
      fileHash,
      fileMtimeMs: stats.mtimeMs,
    }));

    this.store.insertFileChunks(rows, now);

    if (this.semanticEnabled && this.embeddingProvider) {
      try {
        const embeddings = await this.embeddingProvider.embedBatch(
          rows.map((row) => row.content),
        );
        for (let i = 0; i < rows.length; i++) {
          this.options.indexVector(`file:${rows[i].id}`, embeddings[i]);
        }
      } catch {
        this.semanticEnabled = false;
        this.options.onSemanticFailure();
      }
    }

    return {
      indexed: true,
      chunksIndexed: rows.length,
      relativePath,
      removed: false,
    };
  }
}
