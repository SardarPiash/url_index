import { randomUUID, createHash } from 'node:crypto';
import type pg from 'pg';
import { UserError } from './errors.js';

export const comparisonLimitation = 'No HTTP response or API acceptance proves crawling/indexing. Existing discovery exposure and overlapping methods on one URL cannot establish causality or method speed. Timing measures observed confirmation, not the actual indexing moment.';
export async function createExperiment(pool: pg.Pool, method: string, target: string, label?: string, variant='default') {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO experiments(id,method,label,limitations,execution_status,variant) VALUES ($1,$2,$3,$4,'PENDING',$5)`, [id, method, label ?? null, comparisonLimitation,variant]);
    await client.query(`INSERT INTO observations(experiment_id,target_url,state) VALUES ($1,$2,'SUBMITTED')`, [id, target]);
    await client.query('COMMIT');
    return id;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function experimentTarget(pool: pg.Pool, id: string, target: string) {
  const { rows } = await pool.query('SELECT e.*, o.target_url FROM experiments e JOIN observations o ON o.experiment_id=e.id WHERE e.id=$1 AND o.target_url=$2', [id, target]);
  if (!rows[0]) throw new UserError('Experiment/target URL pair not found.');
  return rows[0] as { id: string; method: string; started_at: Date; execution_status: string };
}
export async function beginAction(pool: pg.Pool, experiment: string, kind: string, details: Record<string, unknown> = {}) {
  const id = randomUUID();
  await pool.query('INSERT INTO experiment_actions(id,experiment_id,kind,details) VALUES ($1,$2,$3,$4)', [id, experiment, kind, details]);
  return id;
}
export async function endAction(pool: pg.Pool, id: string, details: Record<string, unknown>, status?: number | null, error?: string | null) {
  await pool.query('UPDATE experiment_actions SET completed_at=clock_timestamp(), details=details || $2::jsonb, http_status=$3, error=$4 WHERE id=$1', [id, details, status ?? null, error ?? null]);
}
export async function finishExperiment(pool: pg.Pool, id: string, execution: string, state = 'SUBMITTED', error?: string | null, status?: number | null) {
  await pool.query('UPDATE experiments SET execution_status=$2 WHERE id=$1', [id, execution]);
  await pool.query('UPDATE observations SET state=$2,error=$3,request_status=$4 WHERE experiment_id=$1', [id, state, error ?? null, status ?? null]);
}
export async function evidence(pool: pg.Pool, id: string, target: string, kind: 'CRAWL' | 'INDEX', time: Date, source: string, verified: boolean, details: Record<string, unknown>) {
  const fingerprint = createHash('sha256').update(JSON.stringify({ target, kind, time, source, details })).digest('hex');
  await pool.query('INSERT INTO evidence_events(id,experiment_id,target_url,kind,observed_at,source,verified,fingerprint,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(experiment_id,fingerprint) DO NOTHING', [randomUUID(), id, target, kind, time, source, verified, fingerprint, details]);
}
