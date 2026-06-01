/**
 * SQLite + sqlite-vec database for prompt ratings.
 * Global DB at ~/.pi/agent/ratings.db
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { embed, embedBatch, getDimensions } from "./embeddings";

const DB_PATH = join(homedir(), ".pi", "agent", "ratings.db");

export interface Interaction {
  id: number;
  sessionFile: string;
  entryId: string;
  cwd: string;
  promptText: string;
  responseText: string;
  modelProvider: string | null;
  modelId: string | null;
  modelName: string | null;
  rating: number;
  createdAt: string;
}

export interface InteractionHit extends Interaction {
  score: number;
  source: "semantic" | "fts";
}

export interface ModelStats {
  modelProvider: string;
  modelId: string;
  modelName: string;
  upvotes: number;
  downvotes: number;
  skips: number;
  total: number;
  upvotePct: number;
}

function toSqliteInteger(value: number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

export class RatingDB {
  private db: Database.Database;
  private initialized = false;
  private semanticAvailable = false;
  private dimensions: number;

  constructor() {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH);
    this.dimensions = getDimensions();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_file TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        response_text TEXT NOT NULL,
        model_provider TEXT,
        model_id TEXT,
        model_name TEXT,
        rating INTEGER DEFAULT 0 NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_interactions_rating ON interactions(rating);
      CREATE INDEX IF NOT EXISTS idx_interactions_model ON interactions(model_provider, model_id);
      CREATE INDEX IF NOT EXISTS idx_interactions_created ON interactions(created_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS interaction_fts USING fts5(
        id UNINDEXED,
        prompt_text,
        response_text
      );

      CREATE TABLE IF NOT EXISTS vector_item_map (
        vector_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL UNIQUE,
        interaction_id INTEGER NOT NULL
      );
    `);

    try {
      sqliteVec.load(this.db);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS prompt_vectors USING vec0(embedding float[${this.dimensions}]);
        CREATE VIRTUAL TABLE IF NOT EXISTS response_vectors USING vec0(embedding float[${this.dimensions}]);
      `);
      this.semanticAvailable = true;
    } catch {
      this.semanticAvailable = false;
    }

    this.initialized = true;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  isSemanticAvailable(): boolean {
    return this.semanticAvailable;
  }

  async insertInteraction(data: {
    sessionFile: string;
    entryId: string;
    cwd: string;
    promptText: string;
    responseText: string;
    modelProvider?: string;
    modelId?: string;
    modelName?: string;
  }): Promise<number> {
    await this.initialize();

    const now = new Date().toISOString();

    const result = this.db
      .prepare(
        `INSERT INTO interactions
         (session_file, entry_id, cwd, prompt_text, response_text,
          model_provider, model_id, model_name, rating, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.sessionFile,
        data.entryId,
        data.cwd,
        data.promptText,
        data.responseText,
        data.modelProvider ?? null,
        data.modelId ?? null,
        data.modelName ?? null,
        0,
        now,
      );

    const interactionId = Number(result.lastInsertRowid);

    // FTS
    this.db
      .prepare(
        `INSERT INTO interaction_fts (id, prompt_text, response_text) VALUES (?, ?, ?)`
      )
      .run(interactionId, data.promptText, data.responseText);

    // Vectors
    if (this.semanticAvailable) {
      try {
        const embeddings = await embedBatch([data.promptText, data.responseText]);
        this.indexVector(`prompt:${interactionId}`, interactionId, embeddings[0], "prompt");
        this.indexVector(`response:${interactionId}`, interactionId, embeddings[1], "response");
      } catch {
        this.semanticAvailable = false;
      }
    }

    return interactionId;
  }

  updateRating(id: number, rating: number): boolean {
    if (rating !== 1 && rating !== 0 && rating !== -1) {
      return false;
    }

    const result = this.db
      .prepare(`UPDATE interactions SET rating = ? WHERE id = ?`)
      .run(rating, id);

    return result.changes > 0;
  }

  getLatestUnrated(): Interaction | null {
    const row = this.db
      .prepare(
        `SELECT id, session_file, entry_id, cwd, prompt_text, response_text,
                model_provider, model_id, model_name, rating, created_at
         FROM interactions
         WHERE rating = 0
         ORDER BY id DESC
         LIMIT 1`
      )
      .get() as RawRow | undefined;

    return row ? toInteraction(row) : null;
  }

  getById(id: number): Interaction | null {
    const row = this.db
      .prepare(
        `SELECT id, session_file, entry_id, cwd, prompt_text, response_text,
                model_provider, model_id, model_name, rating, created_at
         FROM interactions WHERE id = ?`
      )
      .get(id) as RawRow | undefined;

    return row ? toInteraction(row) : null;
  }

  async searchInteractions(options: {
    query: string;
    searchIn?: "prompt" | "response" | "both";
    limit?: number;
    minRating?: number;
  }): Promise<InteractionHit[]> {
    await this.initialize();

    const { query, searchIn = "both", limit = 10 } = options;
    const effectiveLimit = Math.max(1, Math.min(limit, 50));

    const ranked = new Map<number, { score: number; source: "semantic" | "fts" }>();

    // Semantic search
    if (this.semanticAvailable) {
      try {
        const embedding = await embed(query);

        const searchOne = (table: "prompt_vectors" | "response_vectors") => {
          const rows = this.db
            .prepare(
              `SELECT m.item_id, v.distance
               FROM ${table} v
               JOIN vector_item_map m ON m.vector_rowid = v.rowid
               WHERE v.embedding MATCH ? AND v.k = ?
               ORDER BY v.distance`
            )
            .all(new Float32Array(embedding), effectiveLimit * 3) as Array<{
            item_id: string;
            distance: number;
          }>;

          for (const row of rows) {
            const interactionId = extractInteractionId(row.item_id);
            if (!interactionId) continue;
            const score = 1 / (1 + row.distance);
            const existing = ranked.get(interactionId);
            if (!existing || existing.score < score) {
              ranked.set(interactionId, { score, source: "semantic" });
            }
          }
        };

        if (searchIn === "prompt" || searchIn === "both") searchOne("prompt_vectors");
        if (searchIn === "response" || searchIn === "both") searchOne("response_vectors");
      } catch {
        this.semanticAvailable = false;
      }
    }

    // FTS fallback
    if (ranked.size < effectiveLimit) {
      const ftsQuery = toFtsQuery(query);
      const remaining = effectiveLimit * 3;

      const searchFts = (column: "prompt_text" | "response_text") => {
        try {
          const rows = this.db
            .prepare(
              `SELECT id, bm25(interaction_fts) as rank
               FROM interaction_fts
               WHERE interaction_fts MATCH ?
               ORDER BY rank
               LIMIT ?`
            )
            .all(ftsQuery, remaining) as Array<{ id: number; rank: number }>;

          for (const row of rows) {
            const score = 1 / (1 + Math.abs(row.rank));
            const existing = ranked.get(row.id);
            if (!existing || existing.score < score) {
              ranked.set(row.id, { score, source: "fts" });
            }
          }
        } catch {
          // FTS query parse failure — fall through
        }
      };

      if (searchIn === "prompt" || searchIn === "both") searchFts("prompt_text");
      if (searchIn === "response" || searchIn === "both") searchFts("response_text");
    }

    // Build results
    const sorted = Array.from(ranked.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, effectiveLimit);

    const hits: InteractionHit[] = [];
    for (const [id, meta] of sorted) {
      const row = this.db
        .prepare(
          `SELECT id, session_file, entry_id, cwd, prompt_text, response_text,
                  model_provider, model_id, model_name, rating, created_at
           FROM interactions WHERE id = ?`
        )
        .get(id) as RawRow | undefined;

      if (row) {
        hits.push({ ...toInteraction(row), score: meta.score, source: meta.source });
      }
    }

    return hits;
  }

  getModelStats(providerFilter?: string): ModelStats[] {
    const sql = providerFilter
      ? `SELECT model_provider, model_id, model_name,
                SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as upvotes,
                SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) as downvotes,
                SUM(CASE WHEN rating = 0 THEN 1 ELSE 0 END) as skips,
                COUNT(*) as total
         FROM interactions
         WHERE model_provider = ?
         GROUP BY model_provider, model_id
         ORDER BY upvotes DESC`
      : `SELECT model_provider, model_id, model_name,
                SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as upvotes,
                SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) as downvotes,
                SUM(CASE WHEN rating = 0 THEN 1 ELSE 0 END) as skips,
                COUNT(*) as total
         FROM interactions
         GROUP BY model_provider, model_id
         ORDER BY upvotes DESC`;

    const rows = providerFilter
      ? (this.db.prepare(sql).all(providerFilter) as RawStatsRow[])
      : (this.db.prepare(sql).all() as RawStatsRow[]);

    return rows.map((row) => ({
      modelProvider: row.model_provider ?? "unknown",
      modelId: row.model_id ?? "unknown",
      modelName: row.model_name ?? row.model_id ?? "unknown",
      upvotes: Number(row.upvotes),
      downvotes: Number(row.downvotes),
      skips: Number(row.skips),
      total: Number(row.total),
      upvotePct: row.total > 0 ? (Number(row.upvotes) / Number(row.total)) * 100 : 0,
    }));
  }

  private indexVector(
    itemId: string,
    interactionId: number,
    vector: number[],
    table: "prompt" | "response",
  ): void {
    const map = this.db
      .prepare(`SELECT vector_rowid FROM vector_item_map WHERE item_id = ?`)
      .get(itemId) as { vector_rowid: number | bigint } | undefined;

    let rowid: bigint;
    if (map) {
      rowid = toSqliteInteger(map.vector_rowid);
    } else {
      rowid = toSqliteInteger(
        this.db
          .prepare(`INSERT INTO vector_item_map (item_id, interaction_id) VALUES (?, ?)`)
          .run(itemId, interactionId).lastInsertRowid,
      );
    }

    const tableName = table === "prompt" ? "prompt_vectors" : "response_vectors";
    this.db
      .prepare(`INSERT OR REPLACE INTO ${tableName}(rowid, embedding) VALUES (?, ?)`)
      .run(rowid, new Float32Array(vector));
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface RawRow {
  id: number;
  session_file: string;
  entry_id: string;
  cwd: string;
  prompt_text: string;
  response_text: string;
  model_provider: string | null;
  model_id: string | null;
  model_name: string | null;
  rating: number;
  created_at: string;
}

interface RawStatsRow {
  model_provider: string | null;
  model_id: string | null;
  model_name: string | null;
  upvotes: number;
  downvotes: number;
  skips: number;
  total: number;
}

function toInteraction(row: RawRow): Interaction {
  return {
    id: row.id,
    sessionFile: row.session_file,
    entryId: row.entry_id,
    cwd: row.cwd,
    promptText: row.prompt_text,
    responseText: row.response_text,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    modelName: row.model_name,
    rating: row.rating,
    createdAt: row.created_at,
  };
}

function extractInteractionId(itemId: string): number | null {
  const match = itemId.match(/^(?:prompt|response):(\d+)$/);
  return match ? Number(match[1]) : null;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/i)
    .map((t) => t.trim())
    .filter(Boolean);
}

function toFtsQuery(query: string): string {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return query.trim();
  }
  return tokens.map((t) => `${t}*`).join(" OR ");
}
