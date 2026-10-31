import Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as sqliteVec from "sqlite-vec";

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

/** Capture before generating an automatic proposal; parsed list records are not preconditions. */
export interface MemoryWritePrecondition {
  category: MemoryCategory;
  id: string;
  rawLine: string;
}

export interface CategorySnapshot {
  contents: string;
  mode: number;
}

/** Capture all categories before generating a move proposal, not at application time. */
export interface MemoryMovePrecondition {
  record: MemoryWritePrecondition;
  snapshots: Record<MemoryCategory, CategorySnapshot>;
}

/** Capture all categories before generating an automatic add proposal. */
export interface MemoryAddPrecondition {
  snapshots: Record<MemoryCategory, CategorySnapshot>;
}

export interface DuplicateIdResolution {
  /** Stable transaction ID, or null when no repair was needed. */
  transactionId: string | null;
  changes: Array<{
    category: MemoryCategory;
    line: number;
    oldId: string;
    newId: string;
  }>;
}

interface DuplicateJournal {
  version: 1;
  transactionId: string;
  snapshots: Record<MemoryCategory, CategorySnapshot>;
  changes: DuplicateIdResolution["changes"];
}

interface MoveJournal {
  version: 1;
  expected: MemoryWritePrecondition;
  destination: MemoryCategory;
  snapshots: Record<MemoryCategory, CategorySnapshot>;
}

export interface MemoryHit extends StoredMemoryLine {
  score: number;
  source: "semantic" | "fts" | "grep";
}

export interface DuplicateIdWarning {
  code: "duplicate_memory_id";
  id: string;
  locations: Array<{ category: MemoryCategory; line: number }>;
  message: string;
}

export interface RecallResult {
  memories: MemoryHit[];
  searchMode: "semantic" | "fts" | "grep";
  warnings?: DuplicateIdWarning[];
}

export interface RecoveryResult {
  removedLines: Record<MemoryCategory, number>;
  totalRemovedLines: number;
}

export interface InitResult {
  createdMemories: number;
  skippedMemories: number;
  recoveredLines: number;
  semanticEnabled: boolean;
  warnings?: DuplicateIdWarning[];
}

interface SearchRow {
  itemId: string;
  score: number;
  source: "semantic" | "fts" | "grep";
}

interface MemoryManagerOptions {
  memoryDirName?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  semanticEnabled?: boolean;
  embeddingProvider?: EmbeddingProvider | null;
}

interface EmbeddingProvider {
  name(): string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

const DEFAULT_OPTIONS: Required<MemoryManagerOptions> = {
  memoryDirName: ".pi/memory",
  embeddingModel: "sentence-transformers/all-MiniLM-L6-v2",
  embeddingDimensions: 384,
  semanticEnabled: true,
  embeddingProvider: null,
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

  try {
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
      updated: typeof parsed.updated === "string" ? parsed.updated : undefined,
    };
  } catch {
    return null;
  }
}

// Locate the top-level id token without reserializing any other bytes.
function replaceIdToken(line: string, oldId: string, newId: string): string {
  let depth = 0;
  let found: [number, number] | undefined;
  for (let i = 0; i < line.length;) {
    const c = line[i];
    if (c === '"') {
      const start = i++;
      while (i < line.length) {
        if (line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line[i++] === '"') break;
      }
      const token = line.slice(start, i);
      let j = i;
      while (/\s/.test(line[j] ?? "") && j < line.length) j++;
      if (depth === 1 && line[j] === ":" && JSON.parse(token) === "id") {
        if (found)
          throw new Error("Memory duplicate conflict: ambiguous id fields");
        j++;
        while (j < line.length && /\s/.test(line[j])) j++;
        if (line[j] !== '"')
          throw new Error("Memory duplicate conflict: invalid id");
        const valueStart = j++;
        while (j < line.length) {
          if (line[j] === "\\") {
            j += 2;
            continue;
          }
          if (line[j++] === '"') break;
        }
        if (JSON.parse(line.slice(valueStart, j)) !== oldId)
          throw new Error("Memory duplicate conflict: id changed");
        found = [valueStart, j];
        i = j;
      }
    } else {
      if (c === "{" || c === "[") depth++;
      if (c === "}" || c === "]") depth--;
      i++;
    }
  }
  if (!found) throw new Error("Memory duplicate conflict: missing id");
  return line.slice(0, found[0]) + JSON.stringify(newId) + line.slice(found[1]);
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

function emptyRecoveryResult(): RecoveryResult {
  return {
    removedLines: {
      knowledge: 0,
      practices: 0,
      decisions: 0,
    },
    totalRemovedLines: 0,
  };
}

function combineRecoveryResults(
  first: RecoveryResult,
  second: RecoveryResult,
): RecoveryResult {
  const removedLines = Object.fromEntries(
    MEMORY_CATEGORIES.map((category) => [
      category,
      first.removedLines[category] + second.removedLines[category],
    ]),
  ) as Record<MemoryCategory, number>;
  return {
    removedLines,
    totalRemovedLines: first.totalRemovedLines + second.totalRemovedLines,
  };
}

export class NdjsonMemoryStore {
  private memoryDirName: string;
  private readonly beforeReplace?: () => Promise<void>;
  private readonly onDuplicateRecovery?: () => void;
  private readonly moveCheckpoint?: (
    phase:
      | "journal"
      | "destination"
      | "source"
      | "duplicate-prepublish"
      | "duplicate-written"
      | "duplicate-synced"
      | "duplicate-renamed"
      | "duplicate-directory-synced",
  ) => Promise<void>;
  readonly memoryDir: string;

  constructor(
    cwd: string,
    memoryDirName: string,
    beforeReplace?: () => Promise<void>,
    moveCheckpoint?: (
      phase:
        | "journal"
        | "destination"
        | "source"
        | "duplicate-prepublish"
        | "duplicate-written"
        | "duplicate-synced"
        | "duplicate-renamed"
        | "duplicate-directory-synced",
    ) => Promise<void>,
    onDuplicateRecovery?: () => void,
  ) {
    this.onDuplicateRecovery = onDuplicateRecovery;
    this.memoryDirName = memoryDirName;
    this.memoryDir = join(cwd, memoryDirName);
    this.beforeReplace = beforeReplace;
    this.moveCheckpoint = moveCheckpoint;
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    const gitignorePath = join(this.memoryDir, ".gitignore");
    const current = await readFile(gitignorePath, "utf8").catch(() => "");
    const wanted = ["*.db", "*.db-journal", ".runtime/"];
    const lines = new Set(current.split(/\r?\n/).filter(Boolean));
    let changed = current.length === 0;
    for (const line of wanted) {
      if (!lines.has(line)) {
        lines.add(line);
        changed = true;
      }
    }
    if (changed) {
      await writeFile(
        gitignorePath,
        `${Array.from(lines).join("\n")}\n`,
        "utf8",
      );
    }

    for (const category of MEMORY_CATEGORIES) {
      const path = join(this.memoryDir, categoryFileName(category));
      try {
        await writeFile(path, "", { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  /** Hold the project lock while reconciling a canonical snapshot and reading its index. */
  async withIndexSnapshot<T>(
    operation: (
      memories: StoredMemoryLine[],
      validate: () => Promise<void>,
      warnings: DuplicateIdWarning[],
    ) => Promise<T>,
  ): Promise<T> {
    return this.withCategoryLock("knowledge", async () => {
      const snapshots = await this.rawSnapshots();
      const memories: StoredMemoryLine[] = [];
      const locations = new Map<
        string,
        Array<{ category: MemoryCategory; line: number }>
      >();
      for (const category of MEMORY_CATEGORIES) {
        const lines = snapshots.get(category)!.contents.split(/\n/);
        for (let index = 0; index < lines.length; index++) {
          const memory = parseMemoryLine(lines[index], category);
          if (!memory) continue;
          const entries = locations.get(memory.id) ?? [];
          entries.push({ category, line: index + 1 });
          locations.set(memory.id, entries);
          memories.push(memory);
        }
      }
      const warnings: DuplicateIdWarning[] = Array.from(
        locations,
        ([id, entries]) => ({
          code: "duplicate_memory_id" as const,
          id,
          locations: entries,
          message: `Duplicate memory id ${id}; inspect the listed NDJSON lines and assign unique IDs before writing or indexing.`,
        }),
      ).filter((warning) => warning.locations.length > 1);
      const validate = async () => {
        const current = await this.rawSnapshots();
        if (
          !MEMORY_CATEGORIES.every(
            (category) =>
              current.get(category)!.contents ===
                snapshots.get(category)!.contents &&
              current.get(category)!.mode === snapshots.get(category)!.mode,
          )
        )
          throw new Error(
            "Memory index conflict: canonical files changed during reconciliation",
          );
      };
      return operation(memories, validate, warnings);
    });
  }

  async list(category?: MemoryCategory): Promise<StoredMemoryLine[]> {
    return this.withCategoryLock("knowledge", async () => {
      if (category) return this.readCategory(category);
      const all = await Promise.all(
        MEMORY_CATEGORIES.map((entry) => this.readCategory(entry)),
      );
      return all.flat().sort((a, b) => a.created.localeCompare(b.created));
    });
  }

  /** Unconditional when expected is omitted; reviewers must pass a captured precondition. */
  async remember(
    category: MemoryCategory,
    content: string,
    expected?: MemoryAddPrecondition,
  ): Promise<{ memory: StoredMemoryLine; created: boolean }> {
    return this.withCategoryLock(category, async () => {
      const snapshots = await this.snapshots();
      if (
        expected !== undefined &&
        (!expected?.snapshots ||
          !MEMORY_CATEGORIES.every((entry) => {
            const prior = expected.snapshots[entry];
            const current = snapshots.get(entry)!;
            return (
              prior &&
              prior.contents === current.contents &&
              prior.mode === current.mode
            );
          }))
      )
        throw new Error(
          "Memory add conflict: proposal snapshots changed or are missing",
        );
      const normalized = normalizeText(content);
      const existing = snapshots
        .get(category)!
        .memories.find(
          (memory) => normalizeText(memory.content) === normalized,
        );
      if (existing) {
        return { memory: existing, created: false };
      }

      const memory: StoredMemoryLine = {
        category,
        id: uuidv7(),
        content: normalized,
        created: new Date().toISOString(),
      };

      const snapshot = snapshots.get(category)!;
      const prefix =
        snapshot.contents.length > 0 && !snapshot.contents.endsWith("\n")
          ? "\n"
          : "";
      await this.replace(
        category,
        snapshots,
        `${snapshot.contents}${prefix}${serializeMemoryLine(memory)}\n`,
      );
      return { memory, created: true };
    });
  }

  /** Capture before creating an automatic add proposal, not immediately before applying it. */
  async captureAddPrecondition(): Promise<MemoryAddPrecondition> {
    return this.withCategoryLock("knowledge", async () => {
      const snapshots = await this.snapshots();
      return {
        snapshots: Object.fromEntries(
          MEMORY_CATEGORIES.map((entry) => {
            const { contents, mode } = snapshots.get(entry)!;
            return [entry, { contents, mode }];
          }),
        ) as MemoryAddPrecondition["snapshots"],
      };
    });
  }

  async update(
    id: string,
    content: string,
    expected?: MemoryWritePrecondition,
  ): Promise<StoredMemoryLine | null> {
    return this.mutate(id, expected, (memory) => ({
      ...memory,
      content: normalizeText(content),
      updated: new Date().toISOString(),
    }));
  }

  async forget(
    id: string,
    expected?: MemoryWritePrecondition,
  ): Promise<StoredMemoryLine | null> {
    return this.mutate(id, expected, () => null);
  }

  /** Remove only when both the target and all proposal-time category snapshots match. */
  async forgetWithSnapshot(
    id: string,
    targetPrecondition: MemoryWritePrecondition,
    snapshot: MemoryAddPrecondition,
  ): Promise<StoredMemoryLine | null> {
    if (!targetPrecondition || !snapshot)
      throw new Error("Memory removal conflict: preconditions are missing");
    return this.mutate(id, targetPrecondition, () => null, snapshot);
  }

  /** Automatic reviewers must retain this exact raw-line snapshot with each proposal. */
  async captureWritePrecondition(
    id: string,
  ): Promise<MemoryWritePrecondition | null> {
    return this.withCategoryLock("knowledge", async () => {
      const snapshots = await this.snapshots();
      for (const category of MEMORY_CATEGORIES) {
        const lines =
          snapshots.get(category)!.contents.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const rawLine = lines.find(
          (line) => parseMemoryLine(line, category)?.id === id,
        );
        if (rawLine !== undefined) return { id, category, rawLine };
      }
      return null;
    });
  }

  /** Retain all category bytes and modes before generating a move proposal. */
  async captureMovePrecondition(
    id: string,
  ): Promise<MemoryMovePrecondition | null> {
    return this.withCategoryLock("knowledge", async () => {
      const snapshots = await this.snapshots();
      for (const category of MEMORY_CATEGORIES) {
        const lines =
          snapshots.get(category)!.contents.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const rawLine = lines.find(
          (line) => parseMemoryLine(line, category)?.id === id,
        );
        if (rawLine !== undefined)
          return {
            record: { id, category, rawLine },
            snapshots: Object.fromEntries(
              MEMORY_CATEGORIES.map((entry) => {
                const { contents, mode } = snapshots.get(entry)!;
                return [entry, { contents, mode }];
              }),
            ) as MemoryMovePrecondition["snapshots"],
          };
      }
      return null;
    });
  }

  /** Moves require all category snapshots captured before proposing the move. */
  async move(
    precondition: MemoryMovePrecondition,
    destination: MemoryCategory,
  ): Promise<StoredMemoryLine> {
    if (!MEMORY_CATEGORIES.includes(destination))
      throw new Error("Memory move conflict: invalid destination");
    return this.withCategoryLock("knowledge", async () => {
      const snapshots = await this.snapshots();
      if (
        !precondition?.record ||
        !precondition.snapshots ||
        !MEMORY_CATEGORIES.every((category) => {
          const prior = precondition.snapshots[category];
          const current = snapshots.get(category)!;
          return (
            prior &&
            prior.contents === current.contents &&
            prior.mode === current.mode
          );
        })
      )
        throw new Error(
          "Memory move conflict: proposal snapshots changed or are missing",
        );
      const expected = precondition.record;
      const source = snapshots.get(expected.category);
      const memory = source?.memories.find((item) => item.id === expected.id);
      const line = source?.contents
        .match(/[^\n]*\n|[^\n]+$/g)
        ?.find(
          (item) =>
            parseMemoryLine(item, expected.category)?.id === expected.id,
        );
      if (!memory || line !== expected.rawLine)
        throw new Error(
          `Memory move conflict: ${expected.id} changed or was deleted`,
        );
      if (expected.category === destination) return memory;
      const journal: MoveJournal = {
        version: 1,
        expected,
        destination,
        snapshots: Object.fromEntries(
          MEMORY_CATEGORIES.map((category) => {
            const { contents, mode } = snapshots.get(category)!;
            return [category, { contents, mode }];
          }),
        ) as MoveJournal["snapshots"],
      };
      const raw = JSON.stringify(journal);
      const file = await open(this.moveJournalPath(), "wx", 0o600);
      try {
        await file.writeFile(raw, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await this.syncDirectory(this.runtimeDir());
      await this.moveCheckpoint?.("journal");
      await this.recoverMoveLocked();
      return { ...memory, category: destination };
    });
  }

  /** Explicitly assign fresh IDs to every later occurrence in category and line order. */
  async resolveDuplicateIds(
    signal?: AbortSignal,
  ): Promise<DuplicateIdResolution> {
    return this.withCategoryLock(
      "knowledge",
      async () => {
        const snapshots = await this.rawSnapshots();
        const seen = new Set<string>();
        const records: Array<{
          category: MemoryCategory;
          line: number;
          id: string;
        }> = [];
        for (const category of MEMORY_CATEGORIES) {
          const lines = snapshots.get(category)!.contents.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const record = parseMemoryLine(lines[i], category);
            if (!record)
              throw new Error(
                `Memory duplicate conflict: malformed line in ${category}`,
              );
            records.push({ category, line: i + 1, id: record.id });
          }
        }
        const reserved = new Set(records.map((record) => record.id));
        const changes: DuplicateIdResolution["changes"] = [];
        for (const record of records) {
          if (seen.has(record.id)) {
            let newId: string;
            do {
              newId = uuidv7();
            } while (reserved.has(newId));
            reserved.add(newId);
            changes.push({
              category: record.category,
              line: record.line,
              oldId: record.id,
              newId,
            });
          }
          seen.add(record.id);
        }
        if (!changes.length) return { transactionId: null, changes };
        const journal: DuplicateJournal = {
          version: 1,
          transactionId: uuidv7(),
          snapshots: Object.fromEntries(
            snapshots,
          ) as DuplicateJournal["snapshots"],
          changes,
        };
        // Validate all rewrites before making the journal durable.
        this.duplicateStates(journal);
        await this.moveCheckpoint?.("duplicate-prepublish");
        // After publication starts, completion or recovery may still be required.
        signal?.throwIfAborted();
        await this.publishDuplicateFile(
          this.duplicateJournalPath(),
          JSON.stringify(journal),
        );
        await this.moveCheckpoint?.("journal");
        await this.recoverDuplicatesLocked();
        return { transactionId: journal.transactionId, changes };
      },
      signal,
    );
  }

  /** Durable repair receipts, including repairs completed by another read or process. */
  async listDuplicateIdResolutions(): Promise<DuplicateIdResolution[]> {
    return this.withCategoryLock("knowledge", async () => {
      const results: DuplicateIdResolution[] = [];
      for (const name of (await readdir(this.runtimeDir())).sort()) {
        if (!/^duplicate-receipt-[0-9a-f-]{36}\.json$/.test(name)) continue;
        const raw = await readFile(join(this.runtimeDir(), name), "utf8");
        let receipt: DuplicateIdResolution;
        try {
          receipt = JSON.parse(raw);
          if (
            typeof receipt.transactionId !== "string" ||
            name !== `duplicate-receipt-${receipt.transactionId}.json` ||
            !Array.isArray(receipt.changes) ||
            !receipt.changes.length ||
            receipt.changes.some(
              (c) =>
                !MEMORY_CATEGORIES.includes(c.category) ||
                !Number.isInteger(c.line) ||
                c.line < 1 ||
                typeof c.oldId !== "string" ||
                typeof c.newId !== "string",
            )
          )
            throw new Error("invalid receipt");
        } catch {
          throw new Error(
            "Memory duplicate conflict: malformed repair receipt",
          );
        }
        results.push(receipt);
      }
      return results;
    });
  }

  /** Replays a valid interrupted move or throws an explicit conflict without overwriting edits. */
  async recoverMove(): Promise<void> {
    await this.withCategoryLock("knowledge", async () => {});
  }

  private async mutate(
    id: string,
    expected: MemoryWritePrecondition | undefined,
    change: (memory: StoredMemoryLine) => StoredMemoryLine | null,
    expectedSnapshot?: MemoryAddPrecondition,
  ): Promise<StoredMemoryLine | null> {
    return this.withCategoryLock("knowledge", async () => {
      const snapshots = await this.snapshots();
      if (
        expectedSnapshot !== undefined &&
        (!expectedSnapshot.snapshots ||
          !MEMORY_CATEGORIES.every((category) => {
            const prior = expectedSnapshot.snapshots[category];
            const current = snapshots.get(category)!;
            return (
              prior &&
              prior.contents === current.contents &&
              prior.mode === current.mode
            );
          }))
      )
        throw new Error(
          "Memory removal conflict: proposal snapshots changed or are missing",
        );
      for (const category of MEMORY_CATEGORIES) {
        const snapshot = snapshots.get(category)!;
        const memory = snapshot.memories.find((item) => item.id === id);
        if (!memory) continue;
        const lines = snapshot.contents.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const index = lines.findIndex(
          (line) => parseMemoryLine(line, category)?.id === id,
        );
        if (
          expected &&
          (expected.category !== category ||
            expected.id !== id ||
            expected.rawLine !== lines[index])
        )
          throw new Error(`Memory conflict: ${id} changed`);
        const updated = change(memory);
        if (updated) {
          const ending = lines[index].endsWith("\r\n")
            ? "\r\n"
            : lines[index].endsWith("\n")
              ? "\n"
              : "";
          // Keep additional fields and existing key ordering on the changed record.
          const raw = JSON.parse(lines[index]);
          lines[index] =
            JSON.stringify({
              ...raw,
              content: updated.content,
              updated: updated.updated,
            }) + ending;
        } else lines.splice(index, 1);
        await this.replace(category, snapshots, lines.join(""));
        return updated ?? memory;
      }
      if (expected) throw new Error(`Memory conflict: ${id} was deleted`);
      return null;
    });
  }

  async repair(): Promise<RecoveryResult> {
    await this.ensureReady();
    const entries = await Promise.all(
      MEMORY_CATEGORIES.map(async (category) => [
        category,
        await this.withCategoryLock(category, async () => {
          const snapshots = await this.rawSnapshots();
          const contents = snapshots.get(category)!.contents;
          let removedLines = 0;
          const lines = contents.match(/[^\n]*\n|[^\n]+$/g) ?? [];
          const retained = lines.filter((line) => {
            if (!line.trim() || parseMemoryLine(line, category)) return true;
            removedLines++;
            return false;
          });
          if (removedLines > 0)
            await this.replace(category, snapshots, retained.join(""));
          return removedLines;
        }),
      ]),
    );
    const removedLines = Object.fromEntries(entries) as Record<
      MemoryCategory,
      number
    >;

    return {
      removedLines,
      totalRemovedLines: Object.values(removedLines).reduce(
        (total, count) => total + count,
        0,
      ),
    };
  }

  async categoryCounts(): Promise<Record<MemoryCategory, number>> {
    return this.withCategoryLock("knowledge", async () => {
      const entries = await Promise.all(
        MEMORY_CATEGORIES.map(async (category) => [
          category,
          (await this.readCategory(category)).length,
        ]),
      );
      return Object.fromEntries(entries) as Record<MemoryCategory, number>;
    });
  }

  async buildPromptContext(): Promise<string> {
    const knowledge = await this.list("knowledge");
    if (knowledge.length === 0) return "";

    return [
      `Knowledge:\n${knowledge.map((entry) => `- ${entry.content}`).join("\n")}`,
      "Use memory_recall to find relevant project practices and decisions when needed.",
    ].join("\n\n");
  }

  private async readCategory(
    category: MemoryCategory,
  ): Promise<StoredMemoryLine[]> {
    const filePath = join(this.memoryDir, categoryFileName(category));
    const contents = await readFile(filePath, "utf8");
    return contents
      .split(/\r?\n/)
      .map((line) => parseMemoryLine(line, category))
      .filter((entry): entry is StoredMemoryLine => entry !== null);
  }

  private async rawSnapshots(): Promise<Map<MemoryCategory, CategorySnapshot>> {
    const result = new Map<MemoryCategory, CategorySnapshot>();
    for (const category of MEMORY_CATEGORIES) {
      const file = join(this.memoryDir, categoryFileName(category));
      const bytes = await readFile(file);
      let contents: string;
      try {
        contents = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        throw new Error(`Memory conflict: invalid UTF-8 in ${category}`);
      }
      const mode = (await stat(file)).mode & 0o7777;
      result.set(category, { contents, mode });
    }
    return result;
  }

  private async snapshots(): Promise<
    Map<MemoryCategory, CategorySnapshot & { memories: StoredMemoryLine[] }>
  > {
    const raw = await this.rawSnapshots();
    const result = new Map<
      MemoryCategory,
      CategorySnapshot & { memories: StoredMemoryLine[] }
    >();
    const ids = new Set<string>();
    for (const category of MEMORY_CATEGORIES) {
      const { contents, mode } = raw.get(category)!;
      const memories: StoredMemoryLine[] = [];
      for (const line of contents.split(/\n/)) {
        if (!line.trim()) continue;
        const memory = parseMemoryLine(line, category);
        if (!memory)
          throw new Error(
            `Memory conflict: malformed line in ${category}; use memory_repair explicitly`,
          );
        if (ids.has(memory.id))
          throw new Error(`Memory conflict: duplicate id ${memory.id}`);
        ids.add(memory.id);
        memories.push(memory);
      }
      result.set(category, { contents, mode, memories });
    }
    return result;
  }

  private runtimeDir(): string {
    return join(this.memoryDir, ".runtime");
  }
  private duplicateJournalPath(): string {
    return join(this.runtimeDir(), "duplicate-transaction.json");
  }

  private moveJournalPath(): string {
    return join(this.runtimeDir(), "move-transaction.json");
  }

  private async ensurePrivateRuntime(): Promise<void> {
    const path = this.runtimeDir();
    let created = false;
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      (info.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    )
      throw new Error(
        "Memory runtime conflict: private runtime directory is unsafe",
      );
    const ignore = join(path, ".gitignore");
    try {
      await writeFile(ignore, "*\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const ignoreInfo = await lstat(ignore);
    if (!ignoreInfo.isFile() || (await readFile(ignore, "utf8")) !== "*\n")
      throw new Error("Memory runtime conflict: invalid runtime gitignore");
    if (created) {
      await this.syncDirectory(path);
      await this.syncDirectory();
    }
  }

  private async cleanRuntimeTemps(): Promise<void> {
    let removed = false;
    for (const name of await readdir(this.runtimeDir())) {
      if (
        !/^(?:replace|duplicate-publish)-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(
          name,
        )
      )
        continue;
      const path = join(this.runtimeDir(), name);
      if (!(await lstat(path)).isFile())
        throw new Error("Memory runtime conflict: unsafe temporary entry");
      await unlink(path);
      removed = true;
    }
    if (removed) await this.syncDirectory(this.runtimeDir());
  }

  private async syncDirectory(path = this.memoryDir): Promise<void> {
    const dir = await open(path, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  private async publishDuplicateFile(path: string, raw: string): Promise<void> {
    const temp = join(this.runtimeDir(), `duplicate-publish-${uuidv7()}.tmp`);
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(raw, "utf8");
        if (path === this.duplicateJournalPath())
          await this.moveCheckpoint?.("duplicate-written");
        await file.sync();
        if (path === this.duplicateJournalPath())
          await this.moveCheckpoint?.("duplicate-synced");
      } finally {
        await file.close();
      }
      await rename(temp, path);
      if (path === this.duplicateJournalPath())
        await this.moveCheckpoint?.("duplicate-renamed");
      await this.syncDirectory(this.runtimeDir());
      if (path === this.duplicateJournalPath())
        await this.moveCheckpoint?.("duplicate-directory-synced");
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  private duplicateStates(
    journal: DuplicateJournal,
  ): Map<MemoryCategory, CategorySnapshot>[] {
    if (
      journal.version !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        journal.transactionId,
      ) ||
      !journal.snapshots ||
      !Array.isArray(journal.changes) ||
      !journal.changes.length
    )
      throw new Error("invalid journal");
    const before = new Map<MemoryCategory, CategorySnapshot>();
    const records: Array<{
      category: MemoryCategory;
      line: number;
      id: string;
    }> = [];
    for (const category of MEMORY_CATEGORIES) {
      const snapshot = journal.snapshots[category];
      if (
        !snapshot ||
        typeof snapshot.contents !== "string" ||
        !Number.isInteger(snapshot.mode) ||
        snapshot.mode < 0 ||
        snapshot.mode > 0o7777
      )
        throw new Error("invalid snapshot");
      before.set(category, snapshot);
      const lines = snapshot.contents.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const record = parseMemoryLine(lines[i], category);
        if (!record) throw new Error("invalid record");
        records.push({ category, line: i + 1, id: record.id });
      }
    }
    const reserved = new Set(records.map((record) => record.id));
    const seen = new Set<string>();
    let index = 0;
    const output = new Map(
      MEMORY_CATEGORIES.map((category) => [
        category,
        before.get(category)!.contents.split("\n"),
      ]),
    );
    for (const record of records) {
      if (seen.has(record.id)) {
        const change = journal.changes[index++];
        if (
          !change ||
          change.category !== record.category ||
          change.line !== record.line ||
          change.oldId !== record.id ||
          typeof change.newId !== "string" ||
          !change.newId ||
          reserved.has(change.newId)
        )
          throw new Error("invalid change");
        reserved.add(change.newId);
        const lines = output.get(record.category)!;
        lines[record.line - 1] = replaceIdToken(
          lines[record.line - 1],
          record.id,
          change.newId,
        );
      }
      seen.add(record.id);
    }
    if (index !== journal.changes.length) throw new Error("extra changes");
    const states = [before];
    for (const category of MEMORY_CATEGORIES) {
      const contents = output.get(category)!.join("\n");
      if (contents === before.get(category)!.contents) continue;
      const next = new Map(states[states.length - 1]);
      next.set(category, { ...before.get(category)!, contents });
      states.push(next);
    }
    return states;
  }

  private async recoverDuplicatesLocked(): Promise<void> {
    const path = this.duplicateJournalPath();
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let states: Map<MemoryCategory, CategorySnapshot>[];
    let journal: DuplicateJournal;
    try {
      journal = JSON.parse(raw);
      states = this.duplicateStates(journal);
    } catch {
      throw new Error(
        "Memory duplicate conflict: malformed transaction journal",
      );
    }
    const matches = (
      actual: Map<MemoryCategory, CategorySnapshot>,
      expected: Map<MemoryCategory, CategorySnapshot>,
    ) =>
      MEMORY_CATEGORIES.every(
        (category) =>
          actual.get(category)!.contents === expected.get(category)!.contents &&
          actual.get(category)!.mode === expected.get(category)!.mode,
      );
    const checkJournal = async () => {
      if ((await readFile(path, "utf8")) !== raw)
        throw new Error(
          "Memory duplicate conflict: transaction journal changed",
        );
    };
    const actual = await this.rawSnapshots();
    let position = states.findIndex((state) => matches(actual, state));
    if (position < 0)
      throw new Error(
        "Memory duplicate conflict: files changed during interrupted transaction; preserve journal",
      );
    for (; position < states.length - 1; position++) {
      await checkJournal();
      const current = states[position],
        next = states[position + 1];
      const category = MEMORY_CATEGORIES.find(
        (entry) => current.get(entry)!.contents !== next.get(entry)!.contents,
      )!;
      await this.replace(category, current, next.get(category)!.contents);
      await this.moveCheckpoint?.("destination");
    }
    await checkJournal();
    if (!matches(await this.rawSnapshots(), states[states.length - 1]))
      throw new Error(
        "Memory duplicate conflict: files changed before transaction cleanup",
      );
    const receiptPath = join(
      this.runtimeDir(),
      `duplicate-receipt-${journal.transactionId}.json`,
    );
    const receipt = JSON.stringify({
      transactionId: journal.transactionId,
      changes: journal.changes,
    });
    try {
      const existing = await readFile(receiptPath, "utf8");
      if (existing !== receipt)
        throw new Error("Memory duplicate conflict: repair receipt changed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.publishDuplicateFile(receiptPath, receipt);
    }
    await checkJournal();
    if (!matches(await this.rawSnapshots(), states[states.length - 1]))
      throw new Error(
        "Memory duplicate conflict: files changed before transaction cleanup",
      );
    await unlink(path);
    await this.syncDirectory(this.runtimeDir());
    this.onDuplicateRecovery?.();
  }

  private async recoverMoveLocked(): Promise<void> {
    const path = this.moveJournalPath();
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let journal: MoveJournal;
    try {
      journal = JSON.parse(raw);
      if (
        journal.version !== 1 ||
        !journal.expected ||
        typeof journal.expected.id !== "string" ||
        typeof journal.expected.rawLine !== "string" ||
        !MEMORY_CATEGORIES.includes(journal.expected.category) ||
        !MEMORY_CATEGORIES.includes(journal.destination) ||
        journal.destination === journal.expected.category ||
        !journal.snapshots
      )
        throw new Error("invalid fields");
      const ids = new Set<string>();
      for (const category of MEMORY_CATEGORIES) {
        const s = journal.snapshots[category];
        if (
          !s ||
          typeof s.contents !== "string" ||
          !Number.isInteger(s.mode) ||
          s.mode < 0 ||
          s.mode > 0o7777
        )
          throw new Error("invalid snapshot");
        for (const line of s.contents.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
          if (!line.trim()) continue;
          const item = parseMemoryLine(line, category);
          if (!item || ids.has(item.id)) throw new Error("invalid records");
          ids.add(item.id);
        }
      }
      const lines =
        journal.snapshots[journal.expected.category].contents.match(
          /[^\n]*\n|[^\n]+$/g,
        ) ?? [];
      const matching = lines.filter(
        (line) =>
          parseMemoryLine(line, journal.expected.category)?.id ===
          journal.expected.id,
      );
      if (matching.length !== 1 || matching[0] !== journal.expected.rawLine)
        throw new Error("invalid source");
    } catch {
      throw new Error(
        "Memory move conflict: malformed or ambiguous transaction journal",
      );
    }

    const { expected, destination, snapshots } = journal;
    const source = expected.category;
    const sourceAfter = (
      snapshots[source].contents.match(/[^\n]*\n|[^\n]+$/g) ?? []
    )
      .filter((line) => line !== expected.rawLine)
      .join("");
    const destBefore = snapshots[destination].contents;
    const prefix = destBefore && !destBefore.endsWith("\n") ? "\n" : "";
    const destAfter =
      destBefore +
      prefix +
      expected.rawLine +
      (expected.rawLine.endsWith("\n") ? "" : "\n");
    const before = new Map(
      MEMORY_CATEGORIES.map((category) => [category, snapshots[category]]),
    );
    const afterDestination = new Map(before);
    afterDestination.set(destination, {
      ...snapshots[destination],
      contents: destAfter,
    });
    const afterSource = new Map(afterDestination);
    afterSource.set(source, { ...snapshots[source], contents: sourceAfter });
    const actual = await this.rawSnapshots();
    const matches = (state: Map<MemoryCategory, CategorySnapshot>) =>
      MEMORY_CATEGORIES.every(
        (category) =>
          actual.get(category)!.contents === state.get(category)!.contents &&
          actual.get(category)!.mode === state.get(category)!.mode,
      );
    const checkJournal = async () => {
      if ((await readFile(path, "utf8")) !== raw)
        throw new Error("Memory move conflict: transaction journal changed");
    };
    if (matches(before)) {
      await checkJournal();
      await this.replace(destination, before, destAfter);
      await this.moveCheckpoint?.("destination");
    } else if (!matches(afterDestination) && !matches(afterSource)) {
      throw new Error(
        "Memory move conflict: files changed during interrupted transaction; preserve journal and resolve manually",
      );
    }
    if (!matches(afterSource)) {
      await checkJournal();
      await this.replace(source, afterDestination, sourceAfter);
      await this.moveCheckpoint?.("source");
    }
    await checkJournal();
    // Check once more before removing the only recovery record.
    const final = await this.rawSnapshots();
    if (
      !MEMORY_CATEGORIES.every(
        (category) =>
          final.get(category)!.contents ===
            afterSource.get(category)!.contents &&
          final.get(category)!.mode === afterSource.get(category)!.mode,
      )
    )
      throw new Error(
        "Memory move conflict: files changed before transaction cleanup",
      );
    await unlink(path);
    await this.syncDirectory(this.runtimeDir());
  }

  private async replace(
    category: MemoryCategory,
    expected: Map<MemoryCategory, CategorySnapshot>,
    body: string,
  ): Promise<void> {
    const filePath = join(this.memoryDir, categoryFileName(category));
    const temporaryPath = join(this.runtimeDir(), `replace-${uuidv7()}.tmp`);
    try {
      const temporary = await open(temporaryPath, "wx", 0o600);
      try {
        await temporary.writeFile(body, "utf8");
        await temporary.chmod(expected.get(category)!.mode);
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      await this.beforeReplace?.();
      for (const entry of MEMORY_CATEGORIES) {
        const file = join(this.memoryDir, categoryFileName(entry));
        const snapshot = expected.get(entry)!;
        if (
          (await readFile(file, "utf8")) !== snapshot.contents ||
          ((await stat(file)).mode & 0o7777) !== snapshot.mode
        )
          throw new Error(`Memory conflict: ${entry} changed during write`);
      }
      // A non-cooperating editor can still write between these checks and rename.
      await rename(temporaryPath, filePath);
      await this.syncDirectory(this.runtimeDir());
      await this.syncDirectory();
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
  }

  private async withCategoryLock<T>(
    _category: MemoryCategory,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    await this.ensureReady();
    signal?.throwIfAborted();
    // SQLite's OS-managed write lock survives process crashes without PID guessing.
    // Never delete or replace this lock database while any process is using it.
    const db = new Database(join(this.memoryDir, "write-lock.db"), {
      timeout: 0,
    });
    const deadline = Date.now() + 10000;
    try {
      while (true) {
        signal?.throwIfAborted();
        try {
          db.exec("BEGIN IMMEDIATE");
          break;
        } catch (error) {
          if (
            (error as { code?: string }).code !== "SQLITE_BUSY" ||
            Date.now() >= deadline
          )
            throw new Error(`Memory lock unavailable: ${String(error)}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      try {
        signal?.throwIfAborted();
        await this.ensurePrivateRuntime();
        await this.cleanRuntimeTemps();
        signal?.throwIfAborted();
        await this.recoverMoveLocked();
        signal?.throwIfAborted();
        await this.recoverDuplicatesLocked();
        signal?.throwIfAborted();
        return await operation();
      } finally {
        db.exec("ROLLBACK");
      }
    } finally {
      db.close();
    }
  }
}

class PiMemoryIndex {
  private memoryDir: string;
  private options: Required<MemoryManagerOptions>;
  private db: Database.Database | null = null;
  private initialized = false;
  private semanticAvailable = false;
  private embeddingProvider: EmbeddingProvider | null = null;
  private readonly embeddingModel: string;
  private readonly embeddingDimensions: number;

  constructor(memoryDir: string, options: Required<MemoryManagerOptions>) {
    this.memoryDir = memoryDir;
    this.options = options;
    this.embeddingModel = options.embeddingModel;
    this.embeddingDimensions = options.embeddingDimensions;
  }

  private get dbReady(): Database.Database {
    if (!this.db) {
      throw new Error("PiMemoryIndex not initialized");
    }
    return this.db;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(this.memoryDir, { recursive: true });
    this.db = new Database(join(this.memoryDir, "vector.db"));

    this.dbReady.exec(`
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
      CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);

    if (this.options.semanticEnabled) {
      try {
        sqliteVec.load(this.dbReady);
        this.dbReady.exec(`
          CREATE TABLE IF NOT EXISTS vector_item_map (
            vector_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id TEXT NOT NULL UNIQUE
          );

          CREATE VIRTUAL TABLE IF NOT EXISTS vector_index USING vec0(
            embedding float[${this.embeddingDimensions}]
          );
        `);

        const schema = this.dbReady
          .prepare(`SELECT sql FROM sqlite_master WHERE name = 'vector_index'`)
          .get() as { sql: string } | undefined;
        const dimensions = schema?.sql.match(
          /embedding\s+float\s*\[\s*(\d+)\s*\]/i,
        );
        if (!dimensions || Number(dimensions[1]) !== this.embeddingDimensions)
          throw new Error("Incompatible vector dimensions");
        this.embeddingProvider =
          this.options.embeddingProvider ??
          new TransformersEmbeddingProvider(
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
    this.db?.close();
    this.db = null;
    this.initialized = false;
  }

  isSemanticAvailable(): boolean {
    return this.semanticAvailable;
  }

  needsSync(memories: StoredMemoryLine[], force = false): boolean {
    const rows = this.dbReady
      .prepare(
        `SELECT id, category, content, created_at AS created, updated_at AS updated FROM indexed_memories ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      category: string;
      content: string;
      created: string;
      updated: string | null;
    }>;
    const wanted = [...memories]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((m) => ({
        id: m.id,
        category: m.category,
        content: m.content,
        created: m.created,
        updated: m.updated ?? null,
      }));
    const changed = JSON.stringify(rows) !== JSON.stringify(wanted);
    const vectorModel = this.dbReady
      .prepare(`SELECT value FROM memory_meta WHERE key = 'vectors'`)
      .get() as { value: string } | undefined;
    const vectorKey = `${this.embeddingProvider?.name() ?? ""}:${this.embeddingDimensions}`;
    return (
      force ||
      changed ||
      (this.semanticAvailable && vectorModel?.value !== vectorKey)
    );
  }

  async prepareVectors(
    memories: StoredMemoryLine[],
    needed: boolean,
  ): Promise<number[][] | null | undefined> {
    if (!needed) return undefined;
    let vectors: number[][] | null = null;
    if (this.semanticAvailable && this.embeddingProvider) {
      try {
        vectors = await this.embeddingProvider.embedBatch(
          memories.map((m) => m.content),
        );
        if (
          vectors.length !== memories.length ||
          vectors.some(
            (v) =>
              v.length !== this.embeddingDimensions ||
              v.some((n) => !Number.isFinite(n)),
          )
        )
          throw new Error("Invalid embeddings");
      } catch {
        this.semanticAvailable = false;
        vectors = null;
      }
    }
    return vectors;
  }

  async prepareQuery(query: string | undefined): Promise<number[] | null> {
    if (
      query === undefined ||
      !this.semanticAvailable ||
      !this.embeddingProvider
    )
      return null;
    try {
      const result = await this.embeddingProvider.embed(query);
      if (
        result.length !== this.embeddingDimensions ||
        result.some((n) => !Number.isFinite(n))
      )
        throw new Error("Invalid query embedding");
      return result;
    } catch {
      this.semanticAvailable = false;
      return null;
    }
  }

  syncMemories(
    memories: StoredMemoryLine[],
    vectors: number[][] | null | undefined,
    force = false,
  ): void {
    if (!this.needsSync(memories, force)) return;
    if (this.semanticAvailable && vectors === undefined)
      throw new Error("Memory index conflict: vector preparation needed");
    const vectorKey = `${this.embeddingProvider?.name() ?? ""}:${this.embeddingDimensions}`;
    const db = this.dbReady;
    db.transaction(() => {
      db.prepare(`DELETE FROM indexed_memories`).run();
      db.prepare(`DELETE FROM memory_fts`).run();
      const insert = db.prepare(
        `INSERT INTO indexed_memories (id, category, content, created_at, updated_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const fts = db.prepare(
        `INSERT INTO memory_fts (id, category, content) VALUES (?, ?, ?)`,
      );
      const now = new Date().toISOString();
      for (const memory of memories) {
        insert.run(
          memory.id,
          memory.category,
          memory.content,
          memory.created,
          memory.updated ?? null,
          now,
        );
        fts.run(memory.id, memory.category, memory.content);
      }
      if (this.semanticAvailable && vectors) {
        db.prepare(`DELETE FROM vector_index`).run();
        db.prepare(`DELETE FROM vector_item_map`).run();
        for (let i = 0; i < memories.length; i++)
          this.indexVector(`memory:${memories[i].id}`, vectors![i]);
      }
      db.prepare(
        `INSERT OR REPLACE INTO memory_meta(key, value) VALUES ('vectors', ?)`,
      ).run(this.semanticAvailable && vectors ? vectorKey : "invalid");
    })();
  }

  search(
    query: string,
    category: MemoryCategory | undefined,
    limit: number,
    embedding: number[] | null,
  ): RecallResult {
    const ranked = new Map<string, SearchRow>();
    let mode: "semantic" | "fts" | "grep" = "grep";

    if (this.semanticAvailable && embedding) {
      try {
        const rows = this.searchVectors(embedding, category, limit * 3);
        for (const row of rows) {
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
      const rows = this.searchLiteral(query, category, limit * 3);
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

    for (const row of sorted) {
      const id = row.itemId.slice("memory:".length);
      const record = this.dbReady
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
    }

    return { memories, searchMode: mode };
  }

  private searchVectors(
    query: number[],
    category: MemoryCategory | undefined,
    limit: number,
  ): SearchRow[] {
    const count = (
      this.dbReady
        .prepare(`SELECT COUNT(*) AS count FROM vector_item_map`)
        .get() as { count: number }
    ).count;
    if (!count) return [];
    const rows = this.dbReady
      .prepare(
        `
        SELECT m.item_id as item_id, v.distance as distance
        FROM vector_index v
        JOIN vector_item_map m ON m.vector_rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND v.k = ?
        ORDER BY v.distance
      `,
      )
      .all(new Float32Array(query), count) as Array<{
      item_id: string;
      distance: number;
    }>;

    const categoryOf = this.dbReady.prepare(
      `SELECT category FROM indexed_memories WHERE id = ?`,
    );
    return rows
      .filter(
        (row) =>
          !category ||
          (
            categoryOf.get(row.item_id.slice("memory:".length)) as
              { category: string } | undefined
          )?.category === category,
      )
      .slice(0, limit)
      .map((row) => ({
        itemId: row.item_id,
        score: 1 / (1 + row.distance),
        source: "semantic" as const,
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
        ? (this.dbReady
            .prepare(
              `
              SELECT id, bm25(memory_fts) as rank
              FROM memory_fts
              WHERE memory_fts MATCH ?
                AND category = ?
              ORDER BY rank
              LIMIT ?
            `,
            )
            .all(q, category, limit) as Array<{ id: string; rank: number }>)
        : (this.dbReady
            .prepare(
              `
              SELECT id, bm25(memory_fts) as rank
              FROM memory_fts
              WHERE memory_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            `,
            )
            .all(q, limit) as Array<{ id: string; rank: number }>);

      for (const row of memoryRows) {
        rows.push({
          itemId: `memory:${row.id}`,
          score: 1 / (1 + Math.abs(row.rank)),
          source: "fts",
        });
      }
    } catch {
      const token = `%${normalizeText(query)}%`;
      const memoryRows = category
        ? (this.dbReady
            .prepare(
              `SELECT id FROM indexed_memories WHERE category = ? AND LOWER(content) LIKE LOWER(?) LIMIT ?`,
            )
            .all(category, token, limit) as Array<{ id: string }>)
        : (this.dbReady
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
    }

    return rows;
  }

  private searchLiteral(
    query: string,
    category: MemoryCategory | undefined,
    limit: number,
  ): SearchRow[] {
    const rows = category
      ? this.dbReady
          .prepare(
            `SELECT id FROM indexed_memories WHERE category = ? AND instr(lower(content), lower(?)) > 0 LIMIT ?`,
          )
          .all(category, query, limit)
      : this.dbReady
          .prepare(
            `SELECT id FROM indexed_memories WHERE instr(lower(content), lower(?)) > 0 LIMIT ?`,
          )
          .all(query, limit);
    return (rows as Array<{ id: string }>).map((row) => ({
      itemId: `memory:${row.id}`,
      score: 0.4,
      source: "grep",
    }));
  }

  private indexVector(itemId: string, vector: number[]): void {
    const rowid = this.getOrCreateRowId(itemId);
    this.dbReady
      .prepare(
        `INSERT OR REPLACE INTO vector_index(rowid, embedding) VALUES (?, ?)`,
      )
      .run(rowid, new Float32Array(vector));
  }

  private getOrCreateRowId(itemId: string): bigint {
    const existing = this.dbReady
      .prepare(`SELECT vector_rowid FROM vector_item_map WHERE item_id = ?`)
      .get(itemId) as { vector_rowid: number | bigint } | undefined;
    if (existing) {
      return this.toSqliteInteger(existing.vector_rowid);
    }

    return this.toSqliteInteger(
      this.dbReady
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
  private initializing: Promise<void> | null = null;
  private lastRecovery = emptyRecoveryResult();
  private warnings: DuplicateIdWarning[] = [];
  private options: Required<MemoryManagerOptions>;

  /** Warnings from the most recent initialization or reconciliation snapshot. */
  getWarnings(): DuplicateIdWarning[] {
    return this.warnings.map((warning) => ({
      ...warning,
      locations: warning.locations.map((location) => ({ ...location })),
    }));
  }

  constructor(cwd: string, options: MemoryManagerOptions = {}) {
    this.cwd = cwd;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.store = new NdjsonMemoryStore(
      cwd,
      this.options.memoryDirName,
      undefined,
      undefined,
      () => {
        this.warnings = [];
      },
    );
    this.index = new PiMemoryIndex(this.store.memoryDir, this.options);
  }

  async isReady(): Promise<boolean> {
    return exists(this.store.memoryDir);
  }

  private async reconcile(
    query?: { query: string; category?: MemoryCategory; limit: number },
    force = false,
  ): Promise<RecallResult | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        const captured = await this.store.withIndexSnapshot(
          async (memories, validate, warnings) => {
            this.warnings = warnings;
            if (warnings.length > 0)
              return { memories, validate, warnings, needed: false };
            await this.index.initialize();
            return {
              memories,
              validate,
              warnings,
              needed: this.index.needsSync(memories, force),
            };
          },
        );
        if (captured.warnings.length > 0) {
          if (!query) return undefined;
          const needle = query.query.toLowerCase();
          return {
            memories: captured.memories
              .filter(
                (memory) =>
                  (!query.category || memory.category === query.category) &&
                  memory.content.toLowerCase().includes(needle),
              )
              .slice(0, query.limit)
              .map((memory) => ({
                ...memory,
                score: 0.4,
                source: "grep" as const,
              })),
            searchMode: "grep",
            warnings: this.getWarnings(),
          };
        }
        // Provider calls never run while holding the canonical project lock.
        const vectors = query
          ? await this.index.prepareVectors(captured.memories, captured.needed)
          : null;
        const queryVector = await this.index.prepareQuery(query?.query);
        return await this.store.withIndexSnapshot(
          async (_current, validate, warnings) => {
            await captured.validate();
            if (warnings.length > 0)
              throw new Error(
                "Memory index conflict: duplicate IDs appeared during reconciliation",
              );
            this.index.syncMemories(captured.memories, vectors, force);
            const result = query
              ? this.index.search(
                  query.query,
                  query.category,
                  query.limit,
                  queryVector,
                )
              : undefined;
            await validate();
            await captured.validate();
            return result;
          },
        );
      } catch (error) {
        if (
          attempt >= 2 ||
          !(error instanceof Error) ||
          !error.message.startsWith("Memory index conflict:")
        )
          throw error;
      }
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initializing) {
      return this.initializing;
    }

    const initializing = (async () => {
      await this.store.ensureReady();
      this.lastRecovery = emptyRecoveryResult();
      await this.reconcile();
      this.initialized = true;
    })();
    this.initializing = initializing;

    try {
      await initializing;
    } finally {
      if (this.initializing === initializing) {
        this.initializing = null;
      }
    }
  }

  async close(): Promise<void> {
    await this.index.close();
  }

  async captureAddPrecondition(): Promise<MemoryAddPrecondition> {
    await this.initialize();
    const result = await this.store.captureAddPrecondition();
    await this.reconcile();
    return result;
  }

  async resolveDuplicateIds(
    signal?: AbortSignal,
  ): Promise<DuplicateIdResolution> {
    const result = await this.store.resolveDuplicateIds(signal);
    await this.initialize();
    await this.reconcile();
    return result;
  }

  async listDuplicateIdResolutions(): Promise<DuplicateIdResolution[]> {
    const results = await this.store.listDuplicateIdResolutions();
    await this.initialize();
    await this.reconcile();
    return results;
  }

  async remember(
    category: MemoryCategory,
    content: string,
    expected?: MemoryAddPrecondition,
  ): Promise<{ memory: StoredMemoryLine; created: boolean }> {
    await this.initialize();
    const result = await this.store.remember(category, content, expected);
    await this.reconcile();
    return result;
  }

  async recall(options: {
    query: string;
    category?: MemoryCategory;
    limit?: number;
  }): Promise<RecallResult> {
    await this.initialize();
    return (await this.reconcile({
      query: options.query,
      category: options.category,
      limit: Math.max(1, options.limit ?? 10),
    }))!;
  }

  // The interactive update/forget tools omit this precondition; automatic reviewers
  // must capture it before proposing a change and pass it back unchanged.
  async captureWritePrecondition(
    id: string,
  ): Promise<MemoryWritePrecondition | null> {
    await this.initialize();
    const result = await this.store.captureWritePrecondition(id);
    await this.reconcile();
    return result;
  }

  async captureMovePrecondition(
    id: string,
  ): Promise<MemoryMovePrecondition | null> {
    await this.initialize();
    const result = await this.store.captureMovePrecondition(id);
    await this.reconcile();
    return result;
  }

  async move(
    expected: MemoryMovePrecondition,
    destination: MemoryCategory,
  ): Promise<StoredMemoryLine> {
    await this.initialize();
    const moved = await this.store.move(expected, destination);
    await this.reconcile();
    return moved;
  }

  async recoverMove(): Promise<void> {
    await this.store.recoverMove();
    await this.initialize();
    await this.reconcile();
  }

  async update(
    id: string,
    content: string,
    expected?: MemoryWritePrecondition,
  ): Promise<StoredMemoryLine | null> {
    await this.initialize();
    const updated = await this.store.update(id, content, expected);
    if (!updated) {
      return null;
    }
    await this.reconcile();
    return updated;
  }

  async forget(
    id: string,
    expected?: MemoryWritePrecondition,
  ): Promise<StoredMemoryLine | null> {
    await this.initialize();
    const removed = await this.store.forget(id, expected);
    if (removed) {
      await this.reconcile();
    }
    return removed;
  }

  async forgetWithSnapshot(
    id: string,
    targetPrecondition: MemoryWritePrecondition,
    snapshot: MemoryAddPrecondition,
  ): Promise<StoredMemoryLine | null> {
    await this.initialize();
    const removed = await this.store.forgetWithSnapshot(
      id,
      targetPrecondition,
      snapshot,
    );
    if (removed) await this.reconcile();
    return removed;
  }

  async list(): Promise<{
    memories: StoredMemoryLine[];
    counts: Record<MemoryCategory, number>;
  }> {
    await this.initialize();
    const memories = await this.store.list();
    const counts = await this.store.categoryCounts();
    await this.reconcile();
    return { memories, counts };
  }

  async repair(): Promise<RecoveryResult> {
    const wasInitialized = this.initialized;
    await this.initialize();
    const initializationRecovery = wasInitialized
      ? emptyRecoveryResult()
      : this.lastRecovery;
    const recovery = combineRecoveryResults(
      initializationRecovery,
      await this.store.repair(),
    );
    if (recovery.totalRemovedLines > 0) {
      await this.reconcile();
    }
    this.lastRecovery = recovery;
    return recovery;
  }

  async init(force = false, seed = false): Promise<InitResult> {
    await this.initialize();
    if (force) await this.reconcile(undefined, true);
    const recovery = emptyRecoveryResult();

    let createdMemories = 0;
    let skippedMemories = 0;

    if (seed) {
      const seeds = await this.generateSeedMemories();
      for (const s of seeds) {
        const result = await this.remember(s.category, s.content);
        if (result.created) {
          createdMemories++;
        } else {
          skippedMemories++;
        }
      }
    }

    return {
      createdMemories,
      skippedMemories,
      recoveredLines: recovery.totalRemovedLines,
      semanticEnabled:
        this.warnings.length === 0 && this.index.isSemanticAvailable(),
      warnings: this.getWarnings(),
    };
  }

  async buildPromptContext(): Promise<string> {
    await this.initialize();
    // Prompt injection can run again after external edits, including compaction.
    await this.reconcile();
    return this.store.buildPromptContext();
  }

  async learn(_since?: string): Promise<string[]> {
    await this.initialize();
    const sessions = await this.scanRecentSessions(5);
    if (sessions.length === 0) {
      return [];
    }

    const snippets: string[] = [];
    for (const session of sessions) {
      snippets.push(`--- Session: ${session.file} ---`);
      for (const entry of session.entries) {
        if (entry.type !== "message" || !entry.message) {
          continue;
        }
        const role = entry.message.role;
        if (role !== "user" && role !== "assistant") {
          continue;
        }
        const text = extractMessageText(entry.message);
        if (text) {
          snippets.push(`[${role}]: ${text.slice(0, 400)}`);
        }
      }
    }

    return snippets;
  }

  private async scanRecentSessions(
    limit: number,
  ): Promise<Array<{ file: string; entries: unknown[] }>> {
    const home = homedir();
    const resolvedCwd = this.cwd.replace(/^\/+/, "").replace(/[/\\:]/g, "-");
    const sessionDir = join(
      home,
      ".pi",
      "agent",
      "sessions",
      `--${resolvedCwd}--`,
    );

    try {
      const files = await readdir(sessionDir);
      const jsonlFiles = files
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(sessionDir, f));

      const fileStats = await Promise.all(
        jsonlFiles.map(async (path) => {
          const s = await stat(path);
          return { path, mtime: s.mtime.getTime() };
        }),
      );
      fileStats.sort((a, b) => b.mtime - a.mtime);

      const recent = fileStats.slice(0, limit).map((f) => f.path);
      const results: Array<{ file: string; entries: unknown[] }> = [];

      for (const file of recent) {
        const content = await readFile(file, "utf8").catch(() => "");
        if (!content) {
          continue;
        }
        const lines = content.split(/\r?\n/).filter(Boolean);
        const entries: unknown[] = [];
        for (const line of lines) {
          try {
            entries.push(JSON.parse(line));
          } catch {
            // Skip malformed lines
          }
        }
        results.push({ file: file.split("/").pop() ?? file, entries });
      }

      return results;
    } catch {
      return [];
    }
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

      if (
        pkg.dependencies &&
        "@mariozechner/pi-coding-agent" in pkg.dependencies
      ) {
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
        content:
          "Pi extensions in this repo live under the extensions/ directory.",
      });
    }

    if (await exists(join(this.cwd, "skills"))) {
      seeds.push({
        category: "knowledge",
        content: "Pi skills in this repo live under the skills/ directory.",
      });
    }

    const extensionFiles = await collectFiles(
      join(this.cwd, "extensions"),
      ".ts",
    );
    if (extensionFiles.length > 0) {
      seeds.push({
        category: "practices",
        content:
          "Pi extensions in this repo are implemented as TypeScript modules.",
      });
    }

    for (const file of extensionFiles) {
      const contents = await readFile(file, "utf8").catch(() => "");
      if (contents.includes("pi.registerTool(")) {
        seeds.push({
          category: "practices",
          content:
            "Pi extensions register LLM-callable tools via pi.registerTool(...).",
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

async function collectFiles(
  root: string,
  extension: string,
): Promise<string[]> {
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

function extractMessageText(message: {
  content?: string | Array<{ type?: string; text?: string }>;
}): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join(" ");
  }
  return "";
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
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
