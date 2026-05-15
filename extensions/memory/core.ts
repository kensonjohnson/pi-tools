import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import * as sqliteVec from "sqlite-vec";

const execFileAsync = promisify(execFile);

export const MEMORY_CATEGORIES = [
  "knowledge",
  "practices",
  "decisions",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface MemoryLine {
  id: string;
  content: string;
  created: string;
  updated?: string;
}

export interface StoredMemoryLine extends MemoryLine {
  category: MemoryCategory;
}

export interface FileHit {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  source: "semantic" | "fts" | "grep";
}

export interface MemoryHit extends StoredMemoryLine {
  score: number;
  source: "semantic" | "fts" | "grep";
}

export interface RecallResult {
  memories: MemoryHit[];
  files: FileHit[];
  searchMode: "semantic" | "fts" | "grep";
}

export interface InitResult {
  createdMemories: number;
  skippedMemories: number;
  indexedFiles: number;
  skippedFiles: number;
  removedFiles: number;
  chunksIndexed: number;
  semanticEnabled: boolean;
}

interface FileChunk {
  id: string;
  rootPath: string;
  path: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  content: string;
  fileHash: string;
  fileMtimeMs: number;
}

interface SearchRow {
  itemId: string;
  score: number;
  source: "semantic" | "fts" | "grep";
}

interface FileIndexResult {
  indexedFiles: number;
  skippedFiles: number;
  removedFiles: number;
  chunksIndexed: number;
}

interface ActivityEntry {
  kind: string;
  content: string;
  createdAt: string;
}

interface MemoryManagerOptions {
  memoryDirName?: string;
  chunkSizeLines?: number;
  overlapLines?: number;
  maxFileSizeBytes?: number;
  excludeDirs?: string[];
  embeddingModel?: string;
  embeddingDimensions?: number;
  semanticEnabled?: boolean;
}

interface EmbeddingProvider {
  name(): string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

const DEFAULT_OPTIONS: Required<MemoryManagerOptions> = {
  memoryDirName: ".pi/memory",
  chunkSizeLines: 40,
  overlapLines: 5,
  maxFileSizeBytes: 512 * 1024,
  excludeDirs: [".git", "node_modules", ".pi", "dist", "build", "coverage"],
  embeddingModel: "sentence-transformers/all-MiniLM-L6-v2",
  embeddingDimensions: 384,
  semanticEnabled: true,
};

const MODEL_ALIASES: Record<string, string> = {
  "sentence-transformers/all-MiniLM-L6-v2":
    "onnx-community/all-MiniLM-L6-v2-ONNX",
};

type FeatureExtractionPipeline = (
  text: string | string[],
  options?: { pooling?: "mean"; normalize?: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

const pipelineCache = new Map<string, Promise<FeatureExtractionPipeline>>();

function resolveRuntimeModel(model: string): string {
  return MODEL_ALIASES[model] || model;
}

class TransformersEmbeddingProvider implements EmbeddingProvider {
  private model: string;
  private dimensions: number;
  private runtimeModel: string;

  constructor(model: string, dimensions: number) {
    this.model = model;
    this.dimensions = dimensions;
    this.runtimeModel = resolveRuntimeModel(model);
  }

  name(): string {
    return `transformers-embedding:${this.model}`;
  }

  async embed(text: string): Promise<number[]> {
    const embeddings = await this.embedBatch([text]);
    return embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const extractor = await this.getExtractor();
    const output = await extractor(texts, {
      pooling: "mean",
      normalize: true,
    });
    const raw = Array.from(output.data);
    const dims = output.dims;
    if (dims.length !== 2) {
      throw new Error(
        `Unexpected embedding tensor rank ${dims.length} for ${this.runtimeModel}`,
      );
    }

    const [batchSize, width] = dims;
    if (width !== this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimensions}, got ${width}`,
      );
    }

    const embeddings: number[][] = [];
    for (let i = 0; i < batchSize; i++) {
      embeddings.push(raw.slice(i * width, (i + 1) * width));
    }
    return embeddings;
  }

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    const existing = pipelineCache.get(this.runtimeModel);
    if (existing) {
      return existing;
    }

    const created = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return pipeline(
        "feature-extraction",
        this.runtimeModel,
      ) as Promise<FeatureExtractionPipeline>;
    })();

    pipelineCache.set(this.runtimeModel, created);
    return created;
  }
}

function categoryFileName(category: MemoryCategory): string {
  return `${category}.ndjson`;
}

function serializeMemoryLine(memory: MemoryLine): string {
  const ordered: Record<string, string> = {
    content: memory.content,
    id: memory.id,
    created: memory.created,
  };
  if (memory.updated) {
    ordered.updated = memory.updated;
  }
  return JSON.stringify(ordered);
}

function parseMemoryLine(
  line: string,
  category: MemoryCategory,
): StoredMemoryLine | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = JSON.parse(trimmed) as Partial<MemoryLine>;
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.content !== "string" ||
    typeof parsed.created !== "string"
  ) {
    return null;
  }

  return {
    category,
    id: parsed.id,
    content: parsed.content,
    created: parsed.created,
    updated:
      typeof parsed.updated === "string" ? parsed.updated : undefined,
  };
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

function ftsQuery(query: string): string {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return query.trim();
  }
  return tokens.map((token) => `${token}*`).join(" OR ");
}

function stableId(parts: string[]): string {
  return createHash("sha1").update(parts.join("::")).digest("hex");
}

export class NdjsonMemoryStore {
  private cwd: string;
  private memoryDirName: string;
  readonly memoryDir: string;

  constructor(cwd: string, memoryDirName: string) {
    this.cwd = cwd;
    this.memoryDirName = memoryDirName;
    this.memoryDir = join(cwd, memoryDirName);
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    const gitignorePath = join(this.memoryDir, ".gitignore");
    const current = await readFile(gitignorePath, "utf8").catch(() => "");
    const wanted = ["*.db", "*.db-journal"];
    const lines = new Set(current.split(/\r?\n/).filter(Boolean));
    let changed = current.length === 0;
    for (const line of wanted) {
      if (!lines.has(line)) {
        lines.add(line);
        changed = true;
      }
    }
    if (changed) {
      await writeFile(gitignorePath, `${Array.from(lines).join("\n")}\n`, "utf8");
    }

    for (const category of MEMORY_CATEGORIES) {
      const path = join(this.memoryDir, categoryFileName(category));
      try {
        await access(path);
      } catch {
        await writeFile(path, "", "utf8");
      }
    }
  }

  async list(category?: MemoryCategory): Promise<StoredMemoryLine[]> {
    await this.ensureReady();

    if (category) {
      return this.readCategory(category);
    }

    const all = await Promise.all(
      MEMORY_CATEGORIES.map((entry) => this.readCategory(entry)),
    );
    return all.flat().sort((a, b) => a.created.localeCompare(b.created));
  }

  async getById(id: string): Promise<StoredMemoryLine | null> {
    const memories = await this.list();
    return memories.find((memory) => memory.id === id) || null;
  }

  async remember(
    category: MemoryCategory,
    content: string,
  ): Promise<{ memory: StoredMemoryLine; created: boolean }> {
    const normalized = normalizeText(content);
    const existing = (await this.readCategory(category)).find(
      (memory) => normalizeText(memory.content) === normalized,
    );
    if (existing) {
      return { memory: existing, created: false };
    }

    const memory: StoredMemoryLine = {
      category,
      id: randomUUID(),
      content: normalized,
      created: new Date().toISOString(),
    };

    await this.append(category, serializeMemoryLine(memory));
    return { memory, created: true };
  }

  async update(
    id: string,
    content: string,
  ): Promise<StoredMemoryLine | null> {
    const normalized = normalizeText(content);
    for (const category of MEMORY_CATEGORIES) {
      const memories = await this.readCategory(category);
      const index = memories.findIndex((memory) => memory.id === id);
      if (index === -1) {
        continue;
      }

      const updated: StoredMemoryLine = {
        ...memories[index],
        content: normalized,
        updated: new Date().toISOString(),
      };
      memories[index] = updated;
      await this.writeCategory(category, memories);
      return updated;
    }

    return null;
  }

  async forget(id: string): Promise<StoredMemoryLine | null> {
    for (const category of MEMORY_CATEGORIES) {
      const memories = await this.readCategory(category);
      const index = memories.findIndex((memory) => memory.id === id);
      if (index === -1) {
        continue;
      }

      const [removed] = memories.splice(index, 1);
      await this.writeCategory(category, memories);
      return removed;
    }

    return null;
  }

  async categoryCounts(): Promise<Record<MemoryCategory, number>> {
    const entries = await Promise.all(
      MEMORY_CATEGORIES.map(async (category) => [
        category,
        (await this.readCategory(category)).length,
      ]),
    );

    return Object.fromEntries(entries) as Record<MemoryCategory, number>;
  }

  async buildPromptContext(): Promise<string> {
    const knowledge = await this.readCategory("knowledge");
    const practices = await this.readCategory("practices");
    const decisions = await this.readCategory("decisions");

    if (
      knowledge.length === 0 &&
      practices.length === 0 &&
      decisions.length === 0
    ) {
      return "";
    }

    const sections: string[] = [];

    if (knowledge.length > 0) {
      sections.push(
        `Knowledge:\n${knowledge.map((entry) => `- ${entry.content}`).join("\n")}`,
      );
    }

    const summarize = (title: string, items: StoredMemoryLine[]) => {
      if (items.length === 0) {
        return;
      }

      const lines = items
        .slice(0, 20)
        .map((entry) => `- ${entry.id.slice(0, 8)}: ${truncate(entry.content, 120)}`);
      sections.push(`${title} index:\n${lines.join("\n")}`);
    };

    summarize("Practices", practices);
    summarize("Decisions", decisions);

    return sections.join("\n\n");
  }

  private async readCategory(category: MemoryCategory): Promise<StoredMemoryLine[]> {
    const filePath = join(this.memoryDir, categoryFileName(category));
    const contents = await readFile(filePath, "utf8");
    return contents
      .split(/\r?\n/)
      .map((line) => parseMemoryLine(line, category))
      .filter((entry): entry is StoredMemoryLine => entry !== null);
  }

  private async append(category: MemoryCategory, line: string): Promise<void> {
    const filePath = join(this.memoryDir, categoryFileName(category));
    const contents = await readFile(filePath, "utf8");
    const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    await writeFile(filePath, `${contents}${prefix}${line}\n`, "utf8");
  }

  private async writeCategory(
    category: MemoryCategory,
    memories: StoredMemoryLine[],
  ): Promise<void> {
    const filePath = join(this.memoryDir, categoryFileName(category));
    const body = memories.map(serializeMemoryLine).join("\n");
    await writeFile(filePath, body.length > 0 ? `${body}\n` : "", "utf8");
  }
}

class PiMemoryIndex {
  private cwd: string;
  private memoryDir: string;
  private options: Required<MemoryManagerOptions>;
  private db: Database.Database;
  private initialized = false;
  private semanticAvailable = false;
  private embeddingProvider: EmbeddingProvider | null = null;
  private readonly embeddingModel: string;
  private readonly embeddingDimensions: number;

  constructor(
    cwd: string,
    memoryDir: string,
    options: Required<MemoryManagerOptions>,
  ) {
    this.cwd = cwd;
    this.memoryDir = memoryDir;
    this.options = options;
    this.embeddingModel = options.embeddingModel;
    this.embeddingDimensions = options.embeddingDimensions;
    mkdirSync(memoryDir, { recursive: true });
    this.db = new Database(join(memoryDir, "vector.db"));
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexed_memories (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        indexed_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        category UNINDEXED,
        content
      );

      CREATE TABLE IF NOT EXISTS indexed_file_chunks (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        file_mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE(root_path, path, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_file_chunks_path
      ON indexed_file_chunks(root_path, path);

      CREATE VIRTUAL TABLE IF NOT EXISTS file_chunk_fts USING fts5(
        id UNINDEXED,
        path UNINDEXED,
        content
      );

      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    if (this.options.semanticEnabled) {
      try {
        sqliteVec.load(this.db);
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS vector_item_map (
            vector_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id TEXT NOT NULL UNIQUE
          );

          CREATE VIRTUAL TABLE IF NOT EXISTS vector_index USING vec0(
            embedding float[${this.embeddingDimensions}]
          );
        `);

        this.embeddingProvider = new TransformersEmbeddingProvider(
          this.embeddingModel,
          this.embeddingDimensions,
        );
        this.semanticAvailable = true;
      } catch {
        this.semanticAvailable = false;
        this.embeddingProvider = null;
      }
    }

    this.initialized = true;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  isSemanticAvailable(): boolean {
    return this.semanticAvailable;
  }

  async syncMemories(memories: StoredMemoryLine[]): Promise<void> {
    await this.initialize();

    const wantedIds = new Set(memories.map((memory) => memory.id));
    const existingRows = this.db
      .prepare(`SELECT id FROM indexed_memories`)
      .all() as Array<{ id: string }>;

    for (const row of existingRows) {
      if (!wantedIds.has(row.id)) {
        await this.removeMemory(row.id);
      }
    }

    for (const memory of memories) {
      await this.upsertMemory(memory);
    }
  }

  async upsertMemory(memory: StoredMemoryLine): Promise<void> {
    await this.initialize();

    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO indexed_memories (id, category, content, created_at, updated_at, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          category = excluded.category,
          content = excluded.content,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          indexed_at = excluded.indexed_at
      `)
      .run(
        memory.id,
        memory.category,
        memory.content,
        memory.created,
        memory.updated || null,
        now,
      );

    this.db.prepare(`DELETE FROM memory_fts WHERE id = ?`).run(memory.id);
    this.db
      .prepare(
        `INSERT INTO memory_fts (id, category, content) VALUES (?, ?, ?)`,
      )
      .run(memory.id, memory.category, memory.content);

    if (this.semanticAvailable && this.embeddingProvider) {
      try {
        const vector = await this.embeddingProvider.embed(memory.content);
        this.indexVector(`memory:${memory.id}`, vector);
      } catch {
        this.semanticAvailable = false;
      }
    }
  }

  async removeMemory(id: string): Promise<void> {
    await this.initialize();

    this.db.prepare(`DELETE FROM indexed_memories WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM memory_fts WHERE id = ?`).run(id);
    if (this.semanticAvailable) {
      this.removeVector(`memory:${id}`);
    }
  }

  async syncRepoFiles(force = false): Promise<FileIndexResult> {
    await this.initialize();

    const seen = new Set<string>();
    let indexedFiles = 0;
    let skippedFiles = 0;
    let removedFiles = 0;
    let chunksIndexed = 0;

    const files = await this.walk(this.cwd);
    for (const absolutePath of files) {
      const stats = await stat(absolutePath);
      if (!stats.isFile() || stats.size > this.options.maxFileSizeBytes) {
        continue;
      }

      const buffer = await readFile(absolutePath);
      if (looksBinary(buffer)) {
        continue;
      }

      const content = buffer.toString("utf8");
      if (!content.trim()) {
        continue;
      }

      const relativePath = relative(this.cwd, absolutePath).replaceAll("\\", "/");
      seen.add(relativePath);

      const fileHash = createHash("sha256").update(content).digest("hex");
      const existing = this.listFileChunks(relativePath);
      if (
        !force &&
        existing.length > 0 &&
        existing[0].fileHash === fileHash &&
        existing[0].fileMtimeMs === stats.mtimeMs
      ) {
        skippedFiles++;
        continue;
      }

      if (existing.length > 0) {
        this.deleteIndexedFile(relativePath, existing);
      }

      const chunks = chunkText(
        content,
        this.options.chunkSizeLines,
        this.options.overlapLines,
      );
      if (chunks.length === 0) {
        skippedFiles++;
        continue;
      }

      const rows: FileChunk[] = chunks.map((chunk) => ({
        id: stableId([relativePath, String(chunk.chunkIndex)]),
        rootPath: this.cwd,
        path: relativePath,
        chunkIndex: chunk.chunkIndex,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        fileHash,
        fileMtimeMs: stats.mtimeMs,
      }));

      const now = new Date().toISOString();
      const insertChunk = this.db.prepare(`
        INSERT INTO indexed_file_chunks (
          id, root_path, path, chunk_index, start_line, end_line, content,
          file_hash, file_mtime_ms, indexed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = this.db.prepare(
        `INSERT INTO file_chunk_fts (id, path, content) VALUES (?, ?, ?)`,
      );

      const tx = this.db.transaction((entries: FileChunk[]) => {
        for (const entry of entries) {
          insertChunk.run(
            entry.id,
            entry.rootPath,
            entry.path,
            entry.chunkIndex,
            entry.startLine,
            entry.endLine,
            entry.content,
            entry.fileHash,
            entry.fileMtimeMs,
            now,
          );
          insertFts.run(entry.id, entry.path, entry.content);
        }
      });
      tx(rows);

      if (this.semanticAvailable && this.embeddingProvider) {
        try {
          const embeddings = await this.embeddingProvider.embedBatch(
            rows.map((row) => row.content),
          );
          for (let i = 0; i < rows.length; i++) {
            this.indexVector(`file:${rows[i].id}`, embeddings[i]);
          }
        } catch {
          this.semanticAvailable = false;
        }
      }

      indexedFiles++;
      chunksIndexed += rows.length;
    }

    const tracked = this.db
      .prepare(
        `SELECT DISTINCT path FROM indexed_file_chunks WHERE root_path = ? ORDER BY path`,
      )
      .all(this.cwd) as Array<{ path: string }>;

    for (const entry of tracked) {
      if (!seen.has(entry.path)) {
        this.deleteIndexedFile(entry.path, this.listFileChunks(entry.path));
        removedFiles++;
      }
    }

    return {
      indexedFiles,
      skippedFiles,
      removedFiles,
      chunksIndexed,
    };
  }

  async search(
    query: string,
    category: MemoryCategory | undefined,
    limit: number,
  ): Promise<RecallResult> {
    await this.initialize();

    const ranked = new Map<string, SearchRow>();
    let mode: "semantic" | "fts" | "grep" = "grep";

    if (this.semanticAvailable && this.embeddingProvider) {
      try {
        const embedding = await this.embeddingProvider.embed(query);
        const rows = this.searchVectors(embedding, limit * 3);
        for (const row of rows) {
          if (category && row.itemId.startsWith("file:")) {
            continue;
          }
          ranked.set(row.itemId, row);
        }
        if (rows.length > 0) {
          mode = "semantic";
        }
      } catch {
        this.semanticAvailable = false;
      }
    }

    if (ranked.size < limit) {
      const rows = this.searchFts(query, category, limit * 3);
      for (const row of rows) {
        const existing = ranked.get(row.itemId);
        if (!existing || existing.score < row.score) {
          ranked.set(row.itemId, row);
        }
      }
      if (rows.length > 0 && mode === "grep") {
        mode = "fts";
      }
    }

    if (ranked.size < limit) {
      const rows = await this.searchRg(query, category, limit * 3);
      for (const row of rows) {
        if (!ranked.has(row.itemId)) {
          ranked.set(row.itemId, row);
        }
      }
    }

    const sorted = Array.from(ranked.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const memories: MemoryHit[] = [];
    const files: FileHit[] = [];

    for (const row of sorted) {
      if (row.itemId.startsWith("memory:")) {
        const id = row.itemId.slice("memory:".length);
        const record = this.db
          .prepare(
            `SELECT id, category, content, created_at, updated_at FROM indexed_memories WHERE id = ?`,
          )
          .get(id) as
          | {
              id: string;
              category: MemoryCategory;
              content: string;
              created_at: string;
              updated_at: string | null;
            }
          | undefined;
        if (!record) {
          continue;
        }
        memories.push({
          id: record.id,
          category: record.category,
          content: record.content,
          created: record.created_at,
          updated: record.updated_at || undefined,
          score: row.score,
          source: row.source,
        });
        continue;
      }

      if (row.itemId.startsWith("file:")) {
        const id = row.itemId.slice("file:".length);
        const record = this.db
          .prepare(
            `SELECT id, path, start_line, end_line, content FROM indexed_file_chunks WHERE id = ?`,
          )
          .get(id) as
          | {
              id: string;
              path: string;
              start_line: number;
              end_line: number;
              content: string;
            }
          | undefined;
        if (!record) {
          continue;
        }
        files.push({
          id: record.id,
          path: record.path,
          startLine: Number(record.start_line),
          endLine: Number(record.end_line),
          content: record.content,
          score: row.score,
          source: row.source,
        });
      }
    }

    return { memories, files, searchMode: mode };
  }

  async logActivity(kind: string, content: string): Promise<void> {
    await this.initialize();
    const normalized = normalizeText(content);
    if (!normalized) {
      return;
    }

    this.db
      .prepare(
        `INSERT INTO activity_log (kind, content, created_at) VALUES (?, ?, ?)`,
      )
      .run(kind, truncate(normalized, 4000), new Date().toISOString());
  }

  async listActivity(since?: string): Promise<ActivityEntry[]> {
    await this.initialize();
    const rows = since
      ? (this.db
          .prepare(
            `SELECT kind, content, created_at FROM activity_log WHERE created_at >= ? ORDER BY created_at DESC`,
          )
          .all(since) as Array<{
          kind: string;
          content: string;
          created_at: string;
        }>)
      : (this.db
          .prepare(
            `SELECT kind, content, created_at FROM activity_log ORDER BY created_at DESC LIMIT 200`,
          )
          .all() as Array<{
          kind: string;
          content: string;
          created_at: string;
        }>);

    return rows.map((row) => ({
      kind: row.kind,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  private searchVectors(query: number[], limit: number): SearchRow[] {
    const rows = this.db
      .prepare(`
        SELECT m.item_id as item_id, v.distance as distance
        FROM vector_index v
        JOIN vector_item_map m ON m.vector_rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND v.k = ?
        ORDER BY v.distance
      `)
      .all(new Float32Array(query), limit) as Array<{
      item_id: string;
      distance: number;
    }>;

    return rows.map((row) => ({
      itemId: row.item_id,
      score: 1 / (1 + row.distance),
      source: "semantic",
    }));
  }

  private searchFts(
    query: string,
    category: MemoryCategory | undefined,
    limit: number,
  ): SearchRow[] {
    const q = ftsQuery(query);
    const rows: SearchRow[] = [];

    try {
      const memoryRows = category
        ? (this.db
            .prepare(`
              SELECT id, bm25(memory_fts) as rank
              FROM memory_fts
              WHERE memory_fts MATCH ?
                AND category = ?
              ORDER BY rank
              LIMIT ?
            `)
            .all(q, category, limit) as Array<{ id: string; rank: number }>)
        : (this.db
            .prepare(`
              SELECT id, bm25(memory_fts) as rank
              FROM memory_fts
              WHERE memory_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            `)
            .all(q, limit) as Array<{ id: string; rank: number }>);

      for (const row of memoryRows) {
        rows.push({
          itemId: `memory:${row.id}`,
          score: 1 / (1 + Math.abs(row.rank)),
          source: "fts",
        });
      }

      if (!category) {
        const fileRows = this.db
          .prepare(`
            SELECT id, bm25(file_chunk_fts) as rank
            FROM file_chunk_fts
            WHERE file_chunk_fts MATCH ?
            ORDER BY rank
            LIMIT ?
          `)
          .all(q, limit) as Array<{ id: string; rank: number }>;

        for (const row of fileRows) {
          rows.push({
            itemId: `file:${row.id}`,
            score: 1 / (1 + Math.abs(row.rank)),
            source: "fts",
          });
        }
      }
    } catch {
      const token = `%${normalizeText(query)}%`;
      const memoryRows = category
        ? (this.db
            .prepare(
              `SELECT id FROM indexed_memories WHERE category = ? AND LOWER(content) LIKE LOWER(?) LIMIT ?`,
            )
            .all(category, token, limit) as Array<{ id: string }>)
        : (this.db
            .prepare(
              `SELECT id FROM indexed_memories WHERE LOWER(content) LIKE LOWER(?) LIMIT ?`,
            )
            .all(token, limit) as Array<{ id: string }>);

      for (const row of memoryRows) {
        rows.push({
          itemId: `memory:${row.id}`,
          score: 0.6,
          source: "fts",
        });
      }

      if (!category) {
        const fileRows = this.db
          .prepare(
            `SELECT id FROM indexed_file_chunks WHERE LOWER(content) LIKE LOWER(?) LIMIT ?`,
          )
          .all(token, limit) as Array<{ id: string }>;

        for (const row of fileRows) {
          rows.push({
            itemId: `file:${row.id}`,
            score: 0.5,
            source: "fts",
          });
        }
      }
    }

    return rows;
  }

  private async searchRg(
    query: string,
    category: MemoryCategory | undefined,
    limit: number,
  ): Promise<SearchRow[]> {
    const rows: SearchRow[] = [];

    try {
      if (category) {
        const file = join(this.memoryDir, categoryFileName(category));
        const { stdout } = await execFileAsync("rg", [
          "--no-heading",
          "--line-number",
          "--max-count",
          String(limit),
          query,
          file,
        ]);

        const ids = await this.parseRgMemoryHits(stdout, category);
        return ids.map((id, index) => ({
          itemId: `memory:${id}`,
          score: 0.4 - index * 0.01,
          source: "grep",
        }));
      }

      const memoryHits = await Promise.all(
        MEMORY_CATEGORIES.map(async (entry) => {
          const file = join(this.memoryDir, categoryFileName(entry));
          const { stdout } = await execFileAsync("rg", [
            "--no-heading",
            "--line-number",
            "--max-count",
            String(limit),
            query,
            file,
          ]);
          return this.parseRgMemoryHits(stdout, entry);
        }),
      );

      for (const ids of memoryHits.flat()) {
        rows.push({
          itemId: `memory:${ids}`,
          score: 0.4,
          source: "grep",
        });
      }

      const { stdout } = await execFileAsync("rg", [
        "--no-heading",
        "--line-number",
        "--max-count",
        String(limit),
        "--glob",
        "!.git/**",
        "--glob",
        "!node_modules/**",
        "--glob",
        "!.pi/**",
        query,
        this.cwd,
      ]);

      const fileLines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, limit);

      for (const line of fileLines) {
        const [path, lineNumber] = line.split(":", 3);
        const relativePath = relative(this.cwd, path).replaceAll("\\", "/");
        const match = this.db
          .prepare(
            `SELECT id FROM indexed_file_chunks WHERE path = ? AND start_line <= ? AND end_line >= ? LIMIT 1`,
          )
          .get(relativePath, Number(lineNumber), Number(lineNumber)) as
          | { id: string }
          | undefined;
        if (match) {
          rows.push({
            itemId: `file:${match.id}`,
            score: 0.3,
            source: "grep",
          });
        }
      }
    } catch {
      return rows;
    }

    return rows;
  }

  private async parseRgMemoryHits(
    stdout: string,
    category: MemoryCategory,
  ): Promise<string[]> {
    const file = join(this.memoryDir, categoryFileName(category));
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    const ids: string[] = [];

    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const [, lineNumberRaw] = line.split(":", 3);
      const lineNumber = Number(lineNumberRaw);
      const raw = lines[lineNumber - 1];
      const parsed = raw ? parseMemoryLine(raw, category) : null;
      if (parsed) {
        ids.push(parsed.id);
      }
    }

    return ids;
  }

  private listFileChunks(path: string): FileChunk[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM indexed_file_chunks WHERE root_path = ? AND path = ? ORDER BY chunk_index`,
      )
      .all(this.cwd, path) as Array<{
      id: string;
      root_path: string;
      path: string;
      chunk_index: number;
      start_line: number;
      end_line: number;
      content: string;
      file_hash: string;
      file_mtime_ms: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      rootPath: row.root_path,
      path: row.path,
      chunkIndex: Number(row.chunk_index),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      content: row.content,
      fileHash: row.file_hash,
      fileMtimeMs: Number(row.file_mtime_ms),
    }));
  }

  private deleteIndexedFile(path: string, chunks: FileChunk[]): void {
    for (const chunk of chunks) {
      this.db.prepare(`DELETE FROM file_chunk_fts WHERE id = ?`).run(chunk.id);
      if (this.semanticAvailable) {
        this.removeVector(`file:${chunk.id}`);
      }
    }
    this.db
      .prepare(`DELETE FROM indexed_file_chunks WHERE root_path = ? AND path = ?`)
      .run(this.cwd, path);
  }

  private async walk(root: string): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (this.options.excludeDirs.includes(entry.name)) {
          continue;
        }
        files.push(...(await this.walk(join(root, entry.name))));
        continue;
      }

      if (entry.isFile()) {
        files.push(join(root, entry.name));
      }
    }

    return files;
  }

  private indexVector(itemId: string, vector: number[]): void {
    const rowid = this.getOrCreateRowId(itemId);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO vector_index(rowid, embedding) VALUES (?, ?)`,
      )
      .run(rowid, new Float32Array(vector));
  }

  private removeVector(itemId: string): void {
    const existing = this.db
      .prepare(`SELECT vector_rowid FROM vector_item_map WHERE item_id = ?`)
      .get(itemId) as { vector_rowid: number | bigint } | undefined;
    if (!existing) {
      return;
    }

    this.db
      .prepare(`DELETE FROM vector_index WHERE rowid = ?`)
      .run(this.toSqliteInteger(existing.vector_rowid));
    this.db.prepare(`DELETE FROM vector_item_map WHERE item_id = ?`).run(itemId);
  }

  private getOrCreateRowId(itemId: string): bigint {
    const existing = this.db
      .prepare(`SELECT vector_rowid FROM vector_item_map WHERE item_id = ?`)
      .get(itemId) as { vector_rowid: number | bigint } | undefined;
    if (existing) {
      return this.toSqliteInteger(existing.vector_rowid);
    }

    return this.toSqliteInteger(
      this.db
        .prepare(`INSERT INTO vector_item_map (item_id) VALUES (?)`)
        .run(itemId).lastInsertRowid,
    );
  }

  private toSqliteInteger(value: number | bigint): bigint {
    return typeof value === "bigint" ? value : BigInt(value);
  }
}

export class MemoryManager {
  readonly cwd: string;
  private store: NdjsonMemoryStore;
  private index: PiMemoryIndex;
  private initialized = false;
  private lastFileSync = 0;
  private options: Required<MemoryManagerOptions>;

  constructor(cwd: string, options: MemoryManagerOptions = {}) {
    this.cwd = cwd;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.store = new NdjsonMemoryStore(cwd, this.options.memoryDirName);
    this.index = new PiMemoryIndex(
      cwd,
      this.store.memoryDir,
      this.options,
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.store.ensureReady();
    await this.index.initialize();
    await this.index.syncMemories(await this.store.list());
    this.initialized = true;
  }

  async close(): Promise<void> {
    await this.index.close();
  }

  async remember(
    category: MemoryCategory,
    content: string,
  ): Promise<{ memory: StoredMemoryLine; created: boolean }> {
    await this.initialize();
    const result = await this.store.remember(category, content);
    await this.index.upsertMemory(result.memory);
    return result;
  }

  async recall(options: {
    query: string;
    category?: MemoryCategory;
    limit?: number;
    forceFileSync?: boolean;
  }): Promise<RecallResult> {
    await this.initialize();
    await this.syncFilesIfNeeded(Boolean(options.forceFileSync));
    return this.index.search(
      options.query,
      options.category,
      Math.max(1, options.limit ?? 10),
    );
  }

  async update(id: string, content: string): Promise<StoredMemoryLine | null> {
    await this.initialize();
    const updated = await this.store.update(id, content);
    if (!updated) {
      return null;
    }
    await this.index.upsertMemory(updated);
    return updated;
  }

  async forget(id: string): Promise<StoredMemoryLine | null> {
    await this.initialize();
    const removed = await this.store.forget(id);
    if (removed) {
      await this.index.removeMemory(id);
    }
    return removed;
  }

  async list(): Promise<{
    memories: StoredMemoryLine[];
    counts: Record<MemoryCategory, number>;
  }> {
    await this.initialize();
    const memories = await this.store.list();
    const counts = await this.store.categoryCounts();
    return { memories, counts };
  }

  async init(force = false): Promise<InitResult> {
    await this.initialize();
    const seeds = await this.generateSeedMemories();

    let createdMemories = 0;
    let skippedMemories = 0;
    for (const seed of seeds) {
      const result = await this.remember(seed.category, seed.content);
      if (result.created) {
        createdMemories++;
      } else {
        skippedMemories++;
      }
    }

    const sync = await this.syncFiles(force);
    return {
      createdMemories,
      skippedMemories,
      indexedFiles: sync.indexedFiles,
      skippedFiles: sync.skippedFiles,
      removedFiles: sync.removedFiles,
      chunksIndexed: sync.chunksIndexed,
      semanticEnabled: this.index.isSemanticAvailable(),
    };
  }

  async buildPromptContext(): Promise<string> {
    await this.initialize();
    return this.store.buildPromptContext();
  }

  async logActivity(kind: string, content: string): Promise<void> {
    await this.initialize();
    await this.index.logActivity(kind, content);
  }

  async learn(since?: string): Promise<string[]> {
    await this.initialize();
    const activities = await this.index.listActivity(since);
    const memories = await this.store.list();
    const known = new Set(memories.map((memory) => normalizeText(memory.content)));
    const candidates = new Set<string>();

    for (const entry of activities) {
      for (const sentence of splitSentences(entry.content)) {
        const normalized = normalizeText(sentence);
        if (!normalized) {
          continue;
        }
        if (
          /(^|\b)(we use|we prefer|prefer|always|never|should|must|decided|decision|pattern|convention)(\b|$)/i.test(
            normalized,
          ) &&
          !known.has(normalized)
        ) {
          candidates.add(normalized);
        }
      }
    }

    return Array.from(candidates).slice(0, 10);
  }

  async consolidate(since?: string): Promise<string[]> {
    await this.initialize();
    const memories = await this.store.list();
    const filtered = since
      ? memories.filter(
          (memory) =>
            memory.created >= since ||
            (memory.updated !== undefined && memory.updated >= since),
        )
      : memories;

    const suggestions: string[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < filtered.length; i++) {
      for (let j = i + 1; j < filtered.length; j++) {
        const first = filtered[i];
        const second = filtered[j];
        const similarity = textSimilarity(first.content, second.content);
        if (similarity < 0.72) {
          continue;
        }

        const key = [first.id, second.id].sort().join(":");
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        suggestions.push(
          `Possible duplicate (${first.category}/${second.category}): ${first.id.slice(0, 8)} "${truncate(first.content, 80)}" <-> ${second.id.slice(0, 8)} "${truncate(second.content, 80)}"`,
        );
      }
    }

    if (suggestions.length === 0) {
      return ["No obvious duplicates or consolidation targets found."];
    }

    return suggestions.slice(0, 10);
  }

  isSemanticAvailable(): boolean {
    return this.index.isSemanticAvailable();
  }

  private async syncFilesIfNeeded(force: boolean): Promise<void> {
    const ageMs = Date.now() - this.lastFileSync;
    if (!force && this.lastFileSync !== 0 && ageMs < 5 * 60 * 1000) {
      return;
    }

    await this.syncFiles(force);
  }

  private async syncFiles(force: boolean): Promise<FileIndexResult> {
    await this.initialize();
    const result = await this.index.syncRepoFiles(force);
    this.lastFileSync = Date.now();
    return result;
  }

  private async generateSeedMemories(): Promise<
    Array<{ category: MemoryCategory; content: string }>
  > {
    const seeds: Array<{ category: MemoryCategory; content: string }> = [];
    const packageJsonPath = join(this.cwd, "package.json");

    try {
      const raw = await readFile(packageJsonPath, "utf8");
      const pkg = JSON.parse(raw) as {
        name?: string;
        pi?: { extensions?: string[]; skills?: string[] };
        dependencies?: Record<string, string>;
      };

      if (pkg.name) {
        seeds.push({
          category: "knowledge",
          content: `The project package name is ${pkg.name}.`,
        });
      }

      if (pkg.pi?.extensions?.length) {
        seeds.push({
          category: "knowledge",
          content: `Pi discovers extensions from ${pkg.pi.extensions.join(", ")}.`,
        });
      }

      if (pkg.pi?.skills?.length) {
        seeds.push({
          category: "knowledge",
          content: `Pi discovers skills from ${pkg.pi.skills.join(", ")}.`,
        });
      }

      if (pkg.dependencies && "@mariozechner/pi-coding-agent" in pkg.dependencies) {
        seeds.push({
          category: "knowledge",
          content:
            "This repo depends on @mariozechner/pi-coding-agent at runtime.",
        });
      }
    } catch {}

    if (await exists(join(this.cwd, "extensions"))) {
      seeds.push({
        category: "knowledge",
        content: "Pi extensions in this repo live under the extensions/ directory.",
      });
    }

    if (await exists(join(this.cwd, "skills"))) {
      seeds.push({
        category: "knowledge",
        content: "Pi skills in this repo live under the skills/ directory.",
      });
    }

    const extensionFiles = await collectFiles(join(this.cwd, "extensions"), ".ts");
    if (extensionFiles.length > 0) {
      seeds.push({
        category: "practices",
        content: "Pi extensions in this repo are implemented as TypeScript modules.",
      });
    }

    for (const file of extensionFiles) {
      const contents = await readFile(file, "utf8").catch(() => "");
      if (contents.includes("pi.registerTool(")) {
        seeds.push({
          category: "practices",
          content: "Pi extensions register LLM-callable tools via pi.registerTool(...).",
        });
        break;
      }
    }

    return dedupeSeeds(seeds);
  }
}

function dedupeSeeds(
  seeds: Array<{ category: MemoryCategory; content: string }>,
): Array<{ category: MemoryCategory; content: string }> {
  const seen = new Set<string>();
  const output: Array<{ category: MemoryCategory; content: string }> = [];

  for (const seed of seeds) {
    const key = `${seed.category}:${normalizeText(seed.content)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push({
      category: seed.category,
      content: normalizeText(seed.content),
    });
  }

  return output;
}

async function collectFiles(root: string, extension: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path, extension)));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      files.push(path);
    }
  }
  return files;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
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

function looksBinary(buffer: Buffer): boolean {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

function truncate(value: string, length: number): string {
  if (value.length <= length) {
    return value;
  }
  return `${value.slice(0, Math.max(0, length - 3))}...`;
}

function textSimilarity(left: string, right: string): number {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection++;
    }
  }

  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
