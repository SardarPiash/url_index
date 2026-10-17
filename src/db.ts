import pg from 'pg';
export function database() {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://indexer:indexer_local@127.0.0.1:54329/indexer_lab',
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    max: 2,
  });
}

export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
    CREATE TABLE IF NOT EXISTS experiments (
      id uuid PRIMARY KEY,
      method text NOT NULL CHECK (method = 'baseline'),
      started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      label text,
      limitations text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observations (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      experiment_id uuid NOT NULL REFERENCES experiments(id),
      target_url text NOT NULL,
      state text NOT NULL CHECK (state IN ('SUBMITTED','DISCOVERY_ATTEMPTED','API_ACCEPTED','CRAWL_VERIFIED','INDEX_CONFIRMED','NOT_INDEXED','UNKNOWN','ERROR')),
      submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      request_status integer,
      error text,
      api_metadata jsonb,
      first_verified_crawl_at timestamptz,
      index_status text NOT NULL DEFAULT 'UNKNOWN',
      index_evidence_source text,
      index_confirmed_at timestamptz,
      final_result text NOT NULL DEFAULT 'UNKNOWN',
      UNIQUE(experiment_id, target_url)
    );
    ALTER TABLE experiments DROP CONSTRAINT IF EXISTS experiments_method_check;
    ALTER TABLE experiments ADD CONSTRAINT experiments_method_check CHECK (method IN ('baseline', 'google-indexing-api', 'sitemap', 'internal-link', 'redirect', 'feed', 'public-tool', 'url-inspection', 'request-indexing', 'crawl-monitor', 'redirect-gateway', 'cms-publish', 'pagespeed', 'blogger-publish'));
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS api_status text NOT NULL DEFAULT 'UNKNOWN' CHECK (api_status IN ('UNKNOWN','API_ACCEPTED','ERROR'));
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS api_accepted_at timestamptz;
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS request_started_at timestamptz;
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS request_completed_at timestamptz;
    ALTER TABLE experiments ADD COLUMN IF NOT EXISTS execution_status text NOT NULL DEFAULT 'COMPLETED' CHECK (execution_status IN ('PENDING','MANUAL_REQUIRED','COMPLETED','UNSUPPORTED','ERROR'));
    ALTER TABLE experiments DROP CONSTRAINT IF EXISTS experiments_execution_status_check;
    ALTER TABLE experiments ADD CONSTRAINT experiments_execution_status_check CHECK (execution_status IN ('PENDING','MANUAL_REQUIRED','COMPLETED','UNSUPPORTED','ERROR','BLOCKED_CONFIGURATION'));
    ALTER TABLE experiments ADD COLUMN IF NOT EXISTS variant text NOT NULL DEFAULT 'default';
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS discovery_url text;
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS real_request_sent boolean NOT NULL DEFAULT false;
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS published_verified boolean NOT NULL DEFAULT false;
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS run_state text CHECK (run_state IN ('NOT_RUN','BLOCKED_CONFIGURATION','REQUEST_SENT','DISCOVERY_SIGNAL_OBSERVED','CRAWLED','INDEXED','UNKNOWN'));
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS output_metadata jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS crawl_evidence_source text;
    ALTER TABLE observations ADD COLUMN IF NOT EXISTS index_checked_at timestamptz;
    CREATE TABLE IF NOT EXISTS experiment_actions (
      id uuid PRIMARY KEY,
      experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      kind text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      completed_at timestamptz,
      http_status integer,
      error text,
      details jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS evidence_events (
      id uuid PRIMARY KEY,
      experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      target_url text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('CRAWL','INDEX')),
      observed_at timestamptz NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      source text NOT NULL,
      verified boolean NOT NULL,
      fingerprint text NOT NULL,
      details jsonb NOT NULL,
      UNIQUE(experiment_id, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS api_rate_limits (
      name text PRIMARY KEY,
      next_allowed_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS publication_receipts (
      provider text NOT NULL,
      site text NOT NULL,
      target_url text NOT NULL,
      experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      content_sha256 text NOT NULL,
      resource_url text,
      resource_id text,
      status text NOT NULL CHECK (status IN ('PENDING','PUBLISHED','UNKNOWN')),
      PRIMARY KEY(provider,site,target_url)
    );
    CREATE TABLE IF NOT EXISTS http_diagnostics (
      id uuid PRIMARY KEY,
      observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      kind text NOT NULL CHECK (kind = 'APPLICATION_HTTP_FETCH'),
      target_url text NOT NULL,
      result jsonb NOT NULL
    );
  `);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
