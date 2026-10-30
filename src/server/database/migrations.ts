export type Migration = { version: number; sql: string };

export const migrations: Migration[] = [{
  version: 1,
  sql: `
    CREATE TABLE generations (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','processing','completed','failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      input_image_key TEXT NOT NULL,
      output_asset_key TEXT,
      original_filename TEXT NOT NULL,
      content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
      file_size INTEGER NOT NULL CHECK (file_size > 0),
      resolution TEXT,
      generation_settings TEXT NOT NULL DEFAULT '{}',
      error_code TEXT,
      error_message TEXT,
      duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
      worker_job_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      CHECK (status != 'completed' OR output_asset_key IS NOT NULL),
      CHECK (status != 'queued' OR completed_at IS NULL)
    );
    CREATE INDEX generations_created_at_idx ON generations(created_at DESC);
    CREATE INDEX generations_status_created_at_idx ON generations(status, created_at DESC);
  `,
}];
