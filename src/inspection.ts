import { JWT } from 'google-auth-library';
import type pg from 'pg';
import { coveredByProperty, loadIndexingCredentials, safeJson, type IndexingDependencies } from './google-indexing.js';
import { normalizeUrl } from './core.js';
import { UserError } from './errors.js';
import { beginAction, endAction, evidence, experimentTarget, finishExperiment } from './experiment-store.js';

export function consoleProperty(target: string, env: NodeJS.ProcessEnv = process.env): string {
  const property = env.SEARCH_CONSOLE_PROPERTY;
  if (env.SEARCH_CONSOLE_AUTHORIZED !== 'true' || !property) throw new UserError('Configure SEARCH_CONSOLE_AUTHORIZED=true and SEARCH_CONSOLE_PROPERTY for your verified property and authorized identity.');
  if (!coveredByProperty(new URL(target), property)) throw new UserError('URL is outside the authorized Search Console property.');
  return property;
}
export function inspectionInterpretation(data: any, target: string) {
  const result = data?.inspectionResult?.indexStatusResult;
  let canonical: string | null = null;
  try { if (typeof result?.googleCanonical === 'string') canonical = normalizeUrl(result.googleCanonical); } catch { /* untrusted metadata ignored */ }
  const verdict = ['PASS','FAIL','NEUTRAL'].includes(result?.verdict) ? result.verdict as string : 'UNKNOWN';
  const allowed = result?.indexingState === 'INDEXING_ALLOWED';
  const status = verdict === 'PASS' && allowed && canonical === target ? 'INDEX_CONFIRMED' : ['FAIL','NEUTRAL'].includes(verdict) && canonical !== target ? 'NOT_INDEXED' : 'UNKNOWN';
  const crawl = typeof result?.lastCrawlTime === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(result.lastCrawlTime) && Number.isFinite(Date.parse(result.lastCrawlTime)) ? result.lastCrawlTime as string : null;
  return { status, verdict, indexing_allowed: allowed, canonical, last_crawl_time: crawl, limitation: 'API inspects stored indexed-version data, not a live indexability test. Confirmation time is when this lab observed evidence. Historical Google crawl times are retained separately and do not imply a new experiment crawl.' };
}
export async function runInspection(pool: pg.Pool, id: string, target: string, env: NodeJS.ProcessEnv = process.env, injected?: IndexingDependencies) {
  const experiment = await experimentTarget(pool, id, target);
  const action = await beginAction(pool, id, 'URL_INSPECTION');
  let property: string;
  try {
    property = consoleProperty(target, env);
    if (!injected && !env.GOOGLE_APPLICATION_CREDENTIALS) throw new UserError('Missing GOOGLE_APPLICATION_CREDENTIALS for URL Inspection.');
  } catch (error) {
    const reason = error instanceof UserError ? error.message : 'Invalid Search Console configuration.';
    await endAction(pool, action, { reason, live_request: false });
    if (experiment.method === 'url-inspection') await finishExperiment(pool, id, 'MANUAL_REQUIRED');
    return;
  }
  let status: number | null = null;
  const signal = AbortSignal.timeout(20000);
  try {
    let dependencies = injected;
    if (!dependencies) {
      const credentials = await loadIndexingCredentials(env.GOOGLE_APPLICATION_CREDENTIALS!);
      dependencies = { accessToken: async () => {
        const client = new JWT({ email: credentials.client_email, key: credentials.private_key, scopes: ['https://www.googleapis.com/auth/webmasters.readonly'], transporterOptions: { timeout: 10000, retry: false, maxRedirects: 0, maxContentLength: 65536, signal } });
        const auth = await client.authorize();
        if (!auth.access_token) throw new Error('No token');
        return auth.access_token;
      }, fetch: globalThis.fetch };
    }
    const token = await dependencies.accessToken(signal);
    if (!token || /[\r\n]/.test(token)) throw new Error('Invalid token');
    const requestStarted = new Date().toISOString();
    const response = await dependencies.fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { method: 'POST', redirect: 'error', signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inspectionUrl: target, siteUrl: property, languageCode: 'en-US' }) });
    status = response.status;
    const data = await safeJson(response);
    if (status !== 200) throw new Error('API rejected request');
    const interpreted = inspectionInterpretation(data, target);
    const now = new Date();
    await endAction(pool, action, { property, request_started_at: requestStarted, ...interpreted }, status);
    await evidence(pool, id, target, 'INDEX', now, 'SEARCH_CONSOLE_URL_INSPECTION', interpreted.status !== 'UNKNOWN', interpreted);
    // Inspection crawl data is Google-reported history, distinct from server-log-verified Googlebot.
    if (interpreted.status !== 'UNKNOWN') await pool.query(`UPDATE observations SET index_status=$2, index_evidence_source=$3,index_checked_at=$4,
      index_confirmed_at=CASE WHEN $2='INDEX_CONFIRMED' THEN COALESCE(index_confirmed_at,$4) ELSE index_confirmed_at END,
      final_result=$2, state=CASE WHEN $2='UNKNOWN' THEN state ELSE $2 END
      WHERE experiment_id=$1`, [id, interpreted.status, 'SEARCH_CONSOLE_URL_INSPECTION', now]);
    await pool.query('UPDATE observations SET index_checked_at=$2 WHERE experiment_id=$1', [id, now]);
    if (experiment.method === 'url-inspection') await pool.query("UPDATE experiments SET execution_status='COMPLETED' WHERE id=$1", [id]);
  } catch {
    const error = status === null ? 'URL Inspection authentication/transport failed; sensitive details withheld.' : `URL Inspection failed (HTTP ${status}); no indexing inference was made.`;
    await endAction(pool, action, {}, status, error);
    if (experiment.method === 'url-inspection') await finishExperiment(pool, id, 'ERROR', 'ERROR', error, status);
  }
}
