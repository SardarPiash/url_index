import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type pg from 'pg';
import { normalizeUrl } from './core.js';
import { isPublicAddress } from './http-diagnostic.js';
import { UserError } from './errors.js';
import { beginAction, endAction, evidence, experimentTarget } from './experiment-store.js';

export type LogEntry = { timestamp: string; remote_ip: string; url: string; method: string; status: number; user_agent: string };
export type DnsChecks = { reverse: (ip: string) => Promise<string[]>; forward: (name: string) => Promise<string[]> };
const resolver = new Resolver({ timeout: 2000, tries: 1 });
const dns: DnsChecks = { reverse: ip => resolver.reverse(ip), forward: async name => {
  const result = await Promise.allSettled([resolver.resolve4(name), resolver.resolve6(name)]);
  return result.flatMap(item => item.status === 'fulfilled' ? item.value : []);
} };
const canonicalIP = (ip: string) => ipaddr.process(ip).toString();
export async function verifyGooglebot(ip: string, userAgent: string, checks: DnsChecks = dns) {
  if (!isPublicAddress(ip) || !/\bGooglebot(?:-(?:Image|Video|News))?\//i.test(userAgent) || /InspectionTool|GoogleOther|AdsBot/i.test(userAgent)) return { verified: false, reason: 'Not a common Googlebot crawl candidate.' };
  try {
    const names = (await checks.reverse(ip)).slice(0, 5).map(name => name.toLowerCase().replace(/\.$/, ''));
    for (const name of names) {
      // Exclude user-triggered fetchers, AdsBot and broad google.com/googleusercontent.com proxies.
      if (!/^(?:crawl-[a-z0-9-]+\.googlebot\.com|geo-crawl-[a-z0-9-]+\.geo\.googlebot\.com)$/.test(name)) continue;
      if ((await checks.forward(name)).some(address => isIP(address) && canonicalIP(address) === canonicalIP(ip))) return { verified: true, hostname: name, reason: 'Common Googlebot hostname verified with reverse and matching forward DNS.' };
    }
    return { verified: false, reason: 'Reverse/forward DNS did not verify a common Googlebot hostname.' };
  } catch { return { verified: false, reason: 'DNS verification unavailable; identity remains UNKNOWN.' }; }
}
export function parseLogs(content: string): LogEntry[] {
  if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new UserError('Log import exceeds 4 MiB; split it into smaller files.');
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length > 1000) throw new UserError('At most 1000 JSONL log rows per import.');
  return lines.map(line => {
    let entry: any;
    try { entry = JSON.parse(line); } catch { throw new UserError('Invalid JSONL server log.'); }
    if (!entry || !isIP(entry.remote_ip ?? '') || typeof entry.url !== 'string' || typeof entry.user_agent !== 'string' || entry.user_agent.length > 2048 || !['GET','HEAD'].includes(entry.method) || !Number.isInteger(entry.status) || entry.status < 100 || entry.status > 599 || typeof entry.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(entry.timestamp) || !Number.isFinite(Date.parse(entry.timestamp)) || Date.parse(entry.timestamp) > Date.now()) throw new UserError('Log rows require a real remote_ip, HTTP URL, GET/HEAD, status, user_agent and non-future RFC3339 timestamp.');
    normalizeUrl(entry.url);
    return entry as LogEntry;
  });
}
export async function importCrawls(pool: pg.Pool, id: string, target: string, entries: LogEntry[], checks?: DnsChecks) {
  const experiment = await experimentTarget(pool, id, target);
  const action = await beginAction(pool, id, 'IMPORT_OWN_SERVER_LOGS', { imported_rows: entries.length, source_requirement: 'Trusted origin/CDN server logs; remote_ip must not be an untrusted forwarded header.' });
  let verified = 0;
  const deadline = Date.now() + 60000;
  let checksPerformed = 0;
  const cache = new Map<string, Awaited<ReturnType<typeof verifyGooglebot>>>();
  for (const entry of entries) {
    if (normalizeUrl(entry.url) !== target || entry.method !== 'GET') continue;
    const key = entry.remote_ip + ':' + /\bGooglebot(?:-(?:Image|Video|News))?\//i.test(entry.user_agent) + ':' + /InspectionTool|GoogleOther|AdsBot/i.test(entry.user_agent);
    let identity = cache.get(key);
    if (!identity) {
      identity = checksPerformed >= 20 || Date.now() > deadline ? { verified: false, reason: 'DNS verification budget exhausted; import a smaller batch.' } : await verifyGooglebot(entry.remote_ip, entry.user_agent, checks);
      checksPerformed++;
      cache.set(key, identity);
    }
    const time = new Date(entry.timestamp);
    const applicable = time >= experiment.started_at;
    await evidence(pool, id, target, 'CRAWL', time, 'OWN_SERVER_LOG_REVERSE_FORWARD_DNS', identity.verified, { remote_ip: entry.remote_ip, http_status: entry.status, ...identity, after_experiment_start: applicable });
    if (identity.verified && applicable) {
      verified++;
      await pool.query(`UPDATE observations SET first_verified_crawl_at=CASE WHEN first_verified_crawl_at IS NULL OR first_verified_crawl_at>$2 THEN $2 ELSE first_verified_crawl_at END,
        crawl_evidence_source='OWN_SERVER_LOG_REVERSE_FORWARD_DNS', state=CASE WHEN index_status='INDEX_CONFIRMED' THEN state ELSE 'CRAWL_VERIFIED' END WHERE experiment_id=$1`, [id, time]);
    }
  }
  await endAction(pool, action, { verified_matching_rows_after_start: verified });
  if (experiment.method === 'crawl-monitor') await pool.query("UPDATE experiments SET execution_status='COMPLETED' WHERE id=$1", [id]);
  return { matched_verified_rows: verified, limitation: 'Trusted log provenance is an operator requirement. A verified crawl does not prove indexing. Historical crawls are retained without negative experiment timings.' };
}
