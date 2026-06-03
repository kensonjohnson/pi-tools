import type Database from "better-sqlite3";

export interface FileChunkRecord {
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

function scopePredicate(prefix?: string): {
  clause: string;
  params: string[];
} {
  if (!prefix) {
    return { clause: "", params: [] };
  }

  const escaped = prefix.replace(/[\\%_]/g, "\\$&");
  return {
    clause: ` AND (path = ? OR path LIKE ? ESCAPE '\\')`,
    params: [prefix, `${escaped}/%`],
  };
}

export class SQLiteFileChunkStore {
  constructor(private db: Database.Database) {}

  listFileChunks(rootPath: string, path: string): FileChunkRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM indexed_file_chunks WHERE root_path = ? AND path = ? ORDER BY chunk_index`,
      )
      .all(rootPath, path) as Array<{
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

  listTrackedPaths(rootPath: string, prefix?: string): string[] {
    const filter = scopePredicate(prefix);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT path FROM indexed_file_chunks WHERE root_path = ?${filter.clause} ORDER BY path`,
      )
      .all(rootPath, ...filter.params) as Array<{ path: string }>;

    return rows.map((row) => row.path);
  }

  deleteFileChunksUnderPath(
    rootPath: string,
    prefix?: string,
  ): FileChunkRecord[] {
    const filter = scopePredicate(prefix);
    const rows = this.db
      .prepare(
        `SELECT * FROM indexed_file_chunks WHERE root_path = ?${filter.clause} ORDER BY path, chunk_index`,
      )
      .all(rootPath, ...filter.params) as Array<{
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

    if (rows.length === 0) {
      return [];
    }

    const deleteChunk = this.db.prepare(`DELETE FROM file_chunk_fts WHERE id = ?`);
    const deleteRows = this.db.prepare(
      `DELETE FROM indexed_file_chunks WHERE root_path = ? AND id = ?`,
    );

    const tx = this.db.transaction((entries: typeof rows) => {
      for (const row of entries) {
        deleteChunk.run(row.id);
        deleteRows.run(rootPath, row.id);
      }
    });
    tx(rows);

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

  insertFileChunks(rows: FileChunkRecord[], indexedAt: string): void {
    if (rows.length === 0) {
      return;
    }

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

    const tx = this.db.transaction((entries: FileChunkRecord[]) => {
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
          indexedAt,
        );
        insertFts.run(entry.id, entry.path, entry.content);
      }
    });
    tx(rows);
  }
}
