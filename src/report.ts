import { UserError } from './errors.js';
import type pg from 'pg';
import { csvCell, median } from './core.js';

export async function report(pool: pg.Pool, id?: string, label?: string) {
  const { rows } = await pool.query(`SELECT e.id AS experiment_id, e.method, e.variant, e.label, e.execution_status, e.started_at, o.target_url,
    o.state, o.api_status, o.api_accepted_at, o.request_started_at, o.request_completed_at, o.submitted_at, o.request_status, o.error, o.api_metadata,
    o.crawl_evidence_source, o.index_checked_at, o.first_verified_crawl_at, CASE WHEN o.first_verified_crawl_at IS NULL THEN 'UNKNOWN' ELSE 'CRAWL_VERIFIED' END AS crawl_status, o.index_status, o.index_evidence_source, o.index_confirmed_at,
    EXTRACT(EPOCH FROM (o.first_verified_crawl_at - e.started_at))::float8 AS seconds_to_crawl,
    EXTRACT(EPOCH FROM (o.index_confirmed_at - e.started_at))::float8 AS seconds_to_index,
    o.final_result, e.limitations,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',a.kind,'started_at',a.started_at,'completed_at',a.completed_at,'http_status',a.http_status,'error',a.error,'details',a.details) ORDER BY a.started_at) FROM experiment_actions a WHERE a.experiment_id=e.id),'[]'::jsonb) AS action_history,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',v.kind,'observed_at',v.observed_at,'source',v.source,'verified',v.verified,'details',v.details) ORDER BY v.observed_at) FROM evidence_events v WHERE v.experiment_id=e.id),'[]'::jsonb) AS evidence_history, o.discovery_url,o.published_verified,o.output_metadata,(o.run_state='DISCOVERY_SIGNAL_OBSERVED' OR o.state='DISCOVERY_ATTEMPTED') AS discovery_signal_observed,
    (o.real_request_sent OR o.request_started_at IS NOT NULL OR EXISTS(SELECT 1 FROM experiment_actions ar WHERE ar.experiment_id=e.id AND (ar.details->>'request_sent'='true' OR ar.details->>'application_fetch'='true'))) AS real_request_sent,
    CASE WHEN o.index_status='INDEX_CONFIRMED' AND o.index_confirmed_at IS NOT NULL AND o.index_evidence_source IS NOT NULL THEN 'INDEXED'
      WHEN o.first_verified_crawl_at IS NOT NULL AND o.crawl_evidence_source IS NOT NULL THEN 'CRAWLED'
      ELSE COALESCE(o.run_state,CASE WHEN o.state='DISCOVERY_ATTEMPTED' THEN 'DISCOVERY_SIGNAL_OBSERVED'
        WHEN o.request_started_at IS NOT NULL OR o.request_status IS NOT NULL THEN 'REQUEST_SENT'
        WHEN e.execution_status IN ('BLOCKED_CONFIGURATION','MANUAL_REQUIRED') THEN 'BLOCKED_CONFIGURATION'
        WHEN e.execution_status='UNSUPPORTED' THEN 'NOT_RUN' ELSE 'UNKNOWN' END) END AS run_state, EXISTS(SELECT 1 FROM experiment_actions a WHERE a.experiment_id=e.id AND (a.error IS NOT NULL OR a.http_status >= 400)) AS has_action_errors
    FROM experiments e JOIN observations o ON o.experiment_id = e.id
    WHERE ($1::uuid IS NULL OR e.id = $1::uuid) AND ($2::text IS NULL OR e.label=$2) ORDER BY e.started_at, o.id`, [id ?? null, label ?? null]);
  if (id && !rows.length) throw new UserError('Experiment not found.');
  const methods = [...new Set(rows.map(row => JSON.stringify([row.method,row.variant])))];
  const summary = methods.map(key => {
    const [method,variant]=JSON.parse(key);
    const group = rows.filter(row => row.method === method && row.variant===variant);
    const crawled = group.filter(row => row.first_verified_crawl_at !== null);
    const indexed = group.filter(row => row.index_status === 'INDEX_CONFIRMED' && row.index_confirmed_at && row.index_evidence_source);
    return {
      method, variant, requests_sent:group.filter(row=>row.real_request_sent).length, signals_observed:group.filter(row=>row.discovery_signal_observed).length, blocked_configuration:group.filter(row=>row.run_state==='BLOCKED_CONFIGURATION').length, urls_tested: group.length, completed: group.filter(row => row.execution_status === 'COMPLETED').length, manual_required: group.filter(row => row.execution_status === 'MANUAL_REQUIRED').length, unsupported: group.filter(row => row.execution_status === 'UNSUPPORTED').length, api_accepted: group.filter(row => row.api_status === 'API_ACCEPTED').length, verified_crawls: crawled.length,
      crawl_rate: crawled.length / group.length, confirmed_indexed: indexed.length,
      index_rate: indexed.length / group.length,
      median_seconds_to_crawl: median(crawled.map(row => row.seconds_to_crawl)),
      median_seconds_to_index: median(indexed.map(row => row.seconds_to_index)),
      errors: group.filter(row => row.state === 'ERROR' || row.error !== null || row.has_action_errors).length,
      unknown: group.filter(row => row.final_result === 'UNKNOWN').length,
    };
  });
  return { rows, summary };
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]!);
  return [keys.map(csvCell).join(','), ...rows.map(row => keys.map(key => {
    const value = row[key];
    return csvCell(value instanceof Date ? value.toISOString() : value && typeof value === 'object' ? JSON.stringify(value) : value);
  }).join(','))].join('\n') + '\n';
}
