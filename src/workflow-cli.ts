import { parseArgs } from 'node:util';
import { open, writeFile } from 'node:fs/promises';
import { database } from './db.js';
import { normalizeUrl } from './core.js';
import { authorizedUrl } from './http-diagnostic.js';
import { UserError } from './errors.js';
import { discoveryMethods, runDiscovery, type DiscoveryMethod } from './discovery.js';
import { beginAction, createExperiment, endAction, experimentTarget, finishExperiment } from './experiment-store.js';
import { consoleProperty, runInspection } from './inspection.js';
import { importCrawls, parseLogs } from './crawl-monitor.js';
import { toCsv } from './report.js';

const commands = [...discoveryMethods, 'public-tool','request-indexing','url-inspection','crawl-monitor','assess','actions'];
export async function workflowCli(argv: string[]): Promise<boolean> {
  if (!commands.includes(argv[0] ?? '')) return false;
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: Object.fromEntries(['allowed-domain','source','output','experiment','label','tool','performed-at','reference','http-status','logs','method','page-type','csv'].map(name => [name, { type: 'string' as const }])) });
  const [command, input, ...extra] = positionals;
  const allowed = new Set(['allowed-domain','experiment','label', ...(discoveryMethods.includes(command as DiscoveryMethod) ? ['source','output'] : []), ...(command === 'public-tool' ? ['tool','performed-at','reference','http-status'] : []), ...(command === 'request-indexing' ? ['performed-at','reference','http-status'] : []), ...(command === 'crawl-monitor' ? ['logs'] : []), ...(command === 'assess' ? ['method','page-type'] : []), ...(command === 'actions' ? ['csv'] : [])]);
  if (Object.keys(values).some(key => !allowed.has(key))) throw new UserError('This workflow received an option it does not support. See --help and README.');
  if (extra.length || (command === 'actions' ? !!input || !values.experiment : !input || !values['allowed-domain'])) throw new UserError('Workflow requires exactly one URL and --allowed-domain. actions requires only --experiment UUID.');
  if (values.experiment && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.experiment)) throw new UserError('Invalid experiment UUID.');
  if (values.source && values.output) throw new UserError('Choose source verification or artifact output, not both.');
  if (values['performed-at'] && (!/^\d{4}-\d\d-\d\dT/.test(values['performed-at']) || !Number.isFinite(Date.parse(values['performed-at'])) || Date.parse(values['performed-at']) > Date.now())) throw new UserError('--performed-at requires a non-future ISO timestamp.');
  if ((values.reference || values['http-status']) && !values['performed-at']) throw new UserError('Manual response/reference requires --performed-at.');
  if (values['http-status'] && !/^[1-5]\d\d$/.test(values['http-status'])) throw new UserError('--http-status must be 100–599.');
  if (command === 'public-tool' && !['rich-results-test','search-console-live-test','other-authorized-tool'].includes(values.tool ?? '')) throw new UserError('Select --tool rich-results-test, search-console-live-test or other-authorized-tool.');
  if (command === 'assess' && (values.method !== 'google-indexing-api' || !values['page-type'])) throw new UserError('assess requires --method google-indexing-api --page-type TYPE.');
  const target = input ? normalizeUrl(input) : '';
  if (input) authorizedUrl(target, values['allowed-domain']!);
  if (values.source) {
    authorizedUrl(values.source, values['allowed-domain']!);
    if (command === 'internal-link' && new URL(values.source).origin !== new URL(target).origin) throw new UserError('Internal-link source must use the target origin.');
    if (normalizeUrl(values.source) === target && ['internal-link','redirect'].includes(command!)) throw new UserError('Source must differ from target.');
  }
  let reference: string | undefined;
  if (values.reference) { const url = new URL(normalizeUrl(values.reference)); url.search = ''; url.hash = ''; reference = url.href; }
  let logs;
  if (values.logs) {
    const handle = await open(values.logs, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new UserError('Logs must be a regular JSONL file of at most 4 MiB.');
      logs = parseLogs(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  }
  const pool = database();
  try {
    if (command === 'actions') {
      const actions = await pool.query('SELECT * FROM experiment_actions WHERE experiment_id=$1 ORDER BY started_at,id', [values.experiment]);
      const events = await pool.query('SELECT * FROM evidence_events WHERE experiment_id=$1 ORDER BY observed_at,id', [values.experiment]);
      console.log(JSON.stringify({ experiment_id: values.experiment, actions: actions.rows, evidence: events.rows }, null, 2));
      if (values.csv) await writeFile(values.csv, toCsv(actions.rows), { flag: 'wx' });
      return true;
    }
    const method = command === 'assess' ? values.method! : command!;
    let id = values.experiment;
    if (id) {
      const existing = await experimentTarget(pool, id, target);
      if (!['url-inspection','crawl-monitor'].includes(command!) && existing.method !== method) throw new UserError('Experiment method does not match this workflow.');
    } else id = await createExperiment(pool, method, target, values.label);
    if (discoveryMethods.includes(command as DiscoveryMethod)) {
      await runDiscovery(pool, id, command as DiscoveryMethod, target, values['allowed-domain']!, values.source, values.output);
    } else if (command === 'url-inspection') {
      await runInspection(pool, id, target);
    } else if (command === 'crawl-monitor') {
      if (logs) console.log(JSON.stringify(await importCrawls(pool, id, target, logs)));
      else {
        const action = await beginAction(pool, id, 'CRAWL_LOG_CONFIGURATION', { reason: 'Provide --logs trusted-origin.jsonl with actual remote IPs from your own server/CDN logs. No logs are configured; crawl evidence remains UNKNOWN.' });
        await endAction(pool, action, {});
        const current = await experimentTarget(pool, id, target);
        if (current.method === 'crawl-monitor') await finishExperiment(pool, id, 'MANUAL_REQUIRED');
      }
    } else if (command === 'assess') {
      const eligible = ['JobPosting','VideoObject/BroadcastEvent'].includes(values['page-type']!);
      const action = await beginAction(pool, id, 'INDEXING_API_ELIGIBILITY_ASSESSMENT', { page_type: ['JobPosting','VideoObject/BroadcastEvent','Product','Article','VideoObject','BroadcastEvent'].includes(values['page-type']!) ? values['page-type'] : 'UNSUPPORTED_TYPE', reason: eligible ? 'Eligible type declared; use google-indexing-api with a configured authorized property, exact eligible-page allowlist and secure credentials. No API request made.' : 'Product and other unsupported page types cannot use the documented Indexing API. No Google request made.' });
      await endAction(pool, action, {});
      await finishExperiment(pool, id, eligible ? 'MANUAL_REQUIRED' : 'UNSUPPORTED');
    } else {
      let reason: string | undefined;
      if (command === 'request-indexing') {
        try { consoleProperty(target); } catch { reason = 'Configure your verified Search Console property and authorization first. Request Indexing is a manual UI workflow; URL Inspection API does not expose Request Indexing.'; }
      }
      const performed = !!values['performed-at'] && !reason;
      const action = await beginAction(pool, id, performed ? 'OPERATOR_REPORTED_ACTION' : 'MANUAL_CONFIGURATION', { workflow: command, tool: values.tool, performed_at: performed ? values['performed-at'] : null, reference: performed ? reference : undefined, verified: false, reason: reason ?? (performed ? 'Operator-reported action/response only; no inferred Googlebot crawl or indexing.' : command === 'request-indexing' ? 'Open URL Inspection in Search Console for your verified property, use Request Indexing where available, then record --performed-at. No browser action has been performed.' : 'Use the chosen public tool manually and record --performed-at and optional response/reference. No tool has been called automatically.') });
      await endAction(pool, action, {}, performed && values['http-status'] ? Number(values['http-status']) : null);
      await finishExperiment(pool, id, performed ? 'COMPLETED' : 'MANUAL_REQUIRED');
    }
    const result = await pool.query('SELECT e.id AS experiment_id,e.method,e.execution_status,e.started_at,o.state,o.api_status,o.index_status,o.final_result FROM experiments e JOIN observations o ON o.experiment_id=e.id WHERE e.id=$1', [id]);
    console.log(JSON.stringify(result.rows, null, 2));
    if (result.rows[0]?.execution_status === 'ERROR') process.exitCode = 1;
    return true;
  } finally { await pool.end(); }
}
