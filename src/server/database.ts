import initSqlJs from "sql.js";
import type { Database as SqlDatabase, SqlValue } from "sql.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { migrations } from "@/server/database/migrations";
import type { Generation, GenerationStatus } from "@/lib/generations";

export type NewGeneration = Pick<Generation, "id" | "status" | "createdAt" | "updatedAt" | "inputImageKey" | "originalFilename" | "contentType" | "fileSize" | "resolution" | "generationSettings">;
export type TransitionData = { outputAssetKey?: string; errorCode?: string; errorMessage?: string; durationMs?: number; completedAt?: string; workerJobId?: string };

const allowedTransitions: Record<GenerationStatus, GenerationStatus[]> = {
  queued: ["processing", "failed"],
  processing: ["completed", "failed"],
  completed: [],
  failed: [],
};

export class InvalidGenerationTransitionError extends Error {}

function recordFromRow(row: Record<string, SqlValue>): Generation {
  return {
    id: String(row.id),
    status: String(row.status) as GenerationStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    inputImageKey: String(row.input_image_key),
    outputAssetKey: row.output_asset_key === null ? null : String(row.output_asset_key),
    originalFilename: String(row.original_filename),
    contentType: String(row.content_type) as Generation["contentType"],
    fileSize: Number(row.file_size),
    resolution: row.resolution === null ? null : String(row.resolution),
    generationSettings: JSON.parse(String(row.generation_settings)) as Record<string, unknown>,
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    workerJobId: row.worker_job_id === null ? null : String(row.worker_job_id),
    inputImageUrl: `/api/v1/generations/${String(row.id)}/input`,
    assetUrl: row.status === "completed" && row.output_asset_key ? `/api/v1/generations/${String(row.id)}/asset` : null,
  };
}

export class GenerationDatabase {
  private constructor(private readonly db: SqlDatabase, private readonly databasePath: string) {}

  static async open(databasePath: string): Promise<GenerationDatabase> {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const sql = await initSqlJs({ locateFile: file => path.join(process.cwd(), "node_modules", "sql.js", "dist", file) });
    let existing: Uint8Array | undefined;
    try {
      const bytes = readFileSync(databasePath);
      if (bytes.byteLength) existing = new Uint8Array(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const database: SqlDatabase = new sql.Database(existing);
    const instance = new GenerationDatabase(database, databasePath);
    instance.applyMigrations();
    instance.persist();
    return instance;
  }

  private applyMigrations() {
    this.db.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const row = this.first<{ version: number }>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations");
    let current = Number(row?.version ?? 0);
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      this.db.run("BEGIN");
      try {
        this.db.exec(migration.sql);
        this.db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [migration.version, new Date().toISOString()]);
        this.db.run("COMMIT");
        current = migration.version;
      } catch (error) {
        this.db.run("ROLLBACK");
        throw error;
      }
    }
    if (current > migrations.at(-1)!.version) throw new Error("Database schema is newer than this application.");
  }

  private persist() {
    writeFileSync(this.databasePath, Buffer.from(this.db.export()), { mode: 0o600 });
  }

  private first<T>(sql: string, params: SqlValue[] = []): T | null {
    const statement = this.db.prepare(sql, params);
    try { return statement.step() ? statement.getAsObject() as T : null; }
    finally { statement.free(); }
  }

  get(id: string): Generation | null {
    const row = this.first<Record<string, SqlValue>>("SELECT * FROM generations WHERE id = ?", [id]);
    return row ? recordFromRow(row) : null;
  }

  findByIdempotencyKey(key: string): Generation | null {
    const row = this.first<Record<string, SqlValue>>("SELECT * FROM generations WHERE idempotency_key = ?", [key]);
    return row ? recordFromRow(row) : null;
  }

  list(limit: number): Generation[] {
    const statement = this.db.prepare("SELECT * FROM generations ORDER BY created_at DESC LIMIT ?", [limit]);
    const rows: Generation[] = [];
    try { while (statement.step()) rows.push(recordFromRow(statement.getAsObject())); }
    finally { statement.free(); }
    return rows;
  }

  listByStatus(status: GenerationStatus): Generation[] {
    const statement = this.db.prepare("SELECT * FROM generations WHERE status = ? ORDER BY created_at ASC", [status]);
    const rows: Generation[] = [];
    try { while (statement.step()) rows.push(recordFromRow(statement.getAsObject())); }
    finally { statement.free(); }
    return rows;
  }

  create(value: NewGeneration, idempotencyKey: string): Generation {
    this.db.run(`INSERT INTO generations (
      id,status,created_at,updated_at,input_image_key,original_filename,content_type,file_size,resolution,generation_settings,idempotency_key
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
      value.id, value.status, value.createdAt, value.updatedAt, value.inputImageKey, value.originalFilename,
      value.contentType, value.fileSize, value.resolution, JSON.stringify(value.generationSettings), idempotencyKey,
    ]);
    this.persist();
    return this.get(value.id)!;
  }

  transition(id: string, status: GenerationStatus, patch: TransitionData = {}): Generation {
    const current = this.get(id);
    if (!current) throw new Error("Generation not found.");
    if (!allowedTransitions[current.status].includes(status)) throw new InvalidGenerationTransitionError(`Cannot move generation from ${current.status} to ${status}.`);
    if (status === "completed" && !patch.outputAssetKey) throw new InvalidGenerationTransitionError("Completed generations require an output asset.");
    const now = new Date().toISOString();
    this.db.run(`UPDATE generations SET status=?, updated_at=?, completed_at=?, output_asset_key=?, error_code=?, error_message=?, duration_ms=?, worker_job_id=? WHERE id=?`, [
      status, now, patch.completedAt ?? (status === "failed" || status === "completed" ? now : current.completedAt),
      patch.outputAssetKey ?? current.outputAssetKey, patch.errorCode ?? null, patch.errorMessage ?? null,
      patch.durationMs ?? current.durationMs, patch.workerJobId ?? current.workerJobId, id,
    ]);
    this.persist();
    return this.get(id)!;
  }

  setWorkerJobId(id: string, workerJobId: string): Generation {
    this.db.run("UPDATE generations SET worker_job_id=?, updated_at=? WHERE id=?", [workerJobId, new Date().toISOString(), id]);
    this.persist();
    return this.get(id)!;
  }

  delete(id: string) {
    this.db.run("DELETE FROM generations WHERE id = ?", [id]);
    this.persist();
  }

  close() { this.db.close(); }
}
