import { beginAction, endAction } from './experiment-store.js';
import { UserError } from './errors.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { publishIndexing, indexingLimitation, type IndexingConfig, type IndexingDependencies } from './google-indexing.js';

export async function runGoogleExperiment(pool: pg.Pool, config: IndexingConfig, dependencies: IndexingDependencies, label?: string) {
  const id = randomUUID();
  const client = await pool.connect();
  let startedAt: Date;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(`INSERT INTO experiments(id,method,label,limitations,execution_status) VALUES ($1,'google-indexing-api',$2,$3,'PENDING') RETURNING started_at`, [id, label ?? null, indexingLimitation]);
    startedAt = inserted.rows[0].started_at;
    await client.query(`INSERT INTO observations(experiment_id,target_url,state,api_metadata) VALUES ($1,$2,'SUBMITTED',$3)`, [id, config.url, { notification_type: 'URL_UPDATED', property: config.property, page_type: config.pageType }]);
    // Reference every required column before any Google request (detect missing migrations).
    await client.query('SELECT api_status, api_accepted_at, request_started_at, request_completed_at FROM observations LIMIT 0');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  // Persist intent before any external side effect. Never hold a DB transaction over a network call.
  const action = await beginAction(pool, id, 'GOOGLE_INDEXING_API_URL_UPDATED');
  const result = await publishIndexing(config, dependencies);
  try {
    await endAction(pool, action, { ...result, crawl_status: 'UNKNOWN', index_status: 'UNKNOWN' }, result.request_status, result.error);
    await pool.query("UPDATE experiments SET execution_status=$2 WHERE id=$1", [id, result.error ? 'ERROR' : 'COMPLETED']);
    await pool.query(`UPDATE observations SET state=$2, api_status=$3, request_started_at=$4,
      request_completed_at=$5, request_status=$6, api_accepted_at=$7, error=$8, api_metadata=$9 WHERE experiment_id=$1`,
    [id, result.state, result.api_status, result.request_started_at, result.request_completed_at, result.request_status, result.api_accepted_at, result.error, result.api_metadata]);
  } catch {
    // Google may have accepted the request: preserve the ID and never automatically resubmit.
    throw new UserError(`Experiment ${id}: result persistence failed after the API attempt. Delivery may be unknown; do not blindly retry.`);
  }
  return { experiment_id: id, method: 'google-indexing-api', started_at: startedAt, ...result, crawl_status: 'UNKNOWN', index_status: 'UNKNOWN', final_result: 'UNKNOWN', limitations: indexingLimitation };
}
