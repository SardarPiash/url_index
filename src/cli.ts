import { liveCli } from './live-cli.js';
import { workflowCli } from './workflow-cli.js';
import { indexingConfig, loadIndexingCredentials, indexingDependencies } from './google-indexing.js';
import { runGoogleExperiment } from './google-experiment.js';
import { UserError, describeError } from './errors.js';
import { httpDiagnostic, authorizedUrl } from './http-diagnostic.js';
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { database, migrate } from './db.js';
import { importUrls, limitation } from './core.js';
import { report, toCsv } from './report.js';

const help = `URL Indexer Lab
  npm run db:migrate
  npm run cli -- baseline [URL ...] [--csv urls.csv] [--label group-name]
  npm run cli -- report [--experiment UUID] [--label cohort] [--csv reports.csv] [--summary-csv summary.csv]
  npm run cli -- http-fetch URL --allowed-domain your-domain.com
  npm run cli -- google-indexing-api URL [--label group-name]
  npm run cli -- sitemap|internal-link|redirect|feed URL --allowed-domain HOST [--output DIR | --source URL] [--experiment UUID]
  npm run cli -- public-tool URL --allowed-domain HOST --tool rich-results-test [--performed-at ISO --reference URL]
  npm run cli -- request-indexing URL --allowed-domain HOST [--performed-at ISO]
  npm run cli -- url-inspection URL --allowed-domain HOST [--experiment UUID]
  npm run cli -- crawl-monitor URL --allowed-domain HOST [--logs FILE --experiment UUID]
  npm run cli -- assess URL --allowed-domain HOST --method google-indexing-api --page-type Product
  npm run cli -- actions --experiment UUID [--csv NEW_FILE]
  npm run cli -- gateway-serve [--port 8787]
  npm run cli -- gateway-run URL --allowed-domain HOST --variant temporary|permanent
  npm run cli -- cms-publish URL --allowed-domain HOST --variant link|rss|atom|sitemap [--preview | --confirm-publication SHA256]
  npm run cli -- blogger-publish URL --allowed-domain HOST [--preview | --confirm-publication SHA256]
  npm run cli -- pagespeed URL --allowed-domain HOST
  npm run cli -- experiment-suite URL --allowed-domain HOST --label cohort
  npm run cli -- execution-report [--label cohort] [--csv NEW_FILE] [--markdown NEW_FILE]
Discovery without --source prepares local artifacts only; it never publishes to your website.
Google adapter requires explicit authorized-property, eligible-page and credential environment configuration.
CSV input requires a header named url. Baseline records URLs without fetching them.
Optional DATABASE_URL overrides the local Docker database. Baseline, report and HTTP diagnostic need no Google credentials.`;

async function main() {
  if (await liveCli(process.argv.slice(2))) return;
  if (await workflowCli(process.argv.slice(2))) return;
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    csv: { type: 'string' }, label: { type: 'string' }, experiment: { type: 'string' },
    'allowed-domain': { type: 'string' }, 'summary-csv': { type: 'string' }, help: { type: 'boolean' },
  } });
  const [command, ...urls] = positionals;
  if (values.help || !command) { console.log(help); return; }
  if (/^https?:/i.test(command)) throw new UserError('Missing command: use npm run cli -- baseline URL. Baseline records the URL without fetching it. For an application HTTP fetch, use http-fetch URL --allowed-domain your-domain.com.');
  if (!['migrate', 'baseline', 'report', 'http-fetch', 'google-indexing-api'].includes(command)) throw new UserError('Unknown command. Use --help.');
  if (command === 'google-indexing-api' && (urls.length !== 1 || values.csv)) throw new UserError('google-indexing-api requires exactly one URL; CSV is not supported.');
  if (command === 'http-fetch') {
    if (urls.length !== 1 || !values['allowed-domain']) throw new UserError('http-fetch requires exactly one URL and --allowed-domain (a domain you control or are authorized to test).');
    if (values.csv || values.label || values.experiment || values['summary-csv']) throw new UserError('http-fetch accepts only URL and --allowed-domain.');
    authorizedUrl(urls[0]!, values['allowed-domain']);
  } else if (values['allowed-domain']) throw new UserError('--allowed-domain requires http-fetch.');
  if (!['baseline', 'http-fetch', 'google-indexing-api'].includes(command) && urls.length) throw new UserError('Unexpected positional arguments.');
  if (command !== 'report' && (values.experiment || values['summary-csv'])) throw new UserError('Report options require report command.');
  if (!['baseline', 'google-indexing-api', 'report'].includes(command) && values.label) throw new UserError('--label requires baseline, google-indexing-api or report command.');
  if (command === 'migrate' && values.csv) throw new UserError('--csv is not supported for migrate.');
  if (values.experiment && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.experiment)) throw new UserError('Invalid experiment UUID.');
  // Validate the whole import before opening a transaction; no partial batches.
  const targets = command === 'baseline' ? importUrls(urls, values.csv ? await readFile(values.csv, 'utf8') : undefined) : [];
  const googleConfig = command === 'google-indexing-api' ? indexingConfig(urls[0]!) : undefined;
  const googleCredentials = googleConfig ? await loadIndexingCredentials(googleConfig.credentialPath) : undefined;
  const pool = database();
  try {
    if (command === 'migrate') { await migrate(pool); console.log('Database schema ready.'); return; }
    if (googleConfig && googleCredentials) {
      const result = await runGoogleExperiment(pool, googleConfig, indexingDependencies(googleCredentials), values.label);
      console.log(JSON.stringify(result, null, 2));
      if (result.error) process.exitCode = 1;
      return;
    }
    if (command === 'http-fetch') {
      // Check the diagnostic schema before making any request.
      await pool.query('SELECT id FROM http_diagnostics LIMIT 0');
      const result = await httpDiagnostic(urls[0]!, values['allowed-domain']!);
      const id = randomUUID();
      await pool.query('INSERT INTO http_diagnostics(id,kind,target_url,result) VALUES ($1,$2,$3,$4)', [id, result.kind, result.target_url, result]);
      console.log(JSON.stringify({ id, ...result }, null, 2));
      if (result.error) process.exitCode = 1;
      return;
    }
    if (command === 'baseline') {
      const client = await pool.connect();
      const id = randomUUID();
      try {
        await client.query('BEGIN');
        const result = await client.query(`INSERT INTO experiments(id, method, label, limitations) VALUES ($1, 'baseline', $2, $3) RETURNING started_at`, [id, values.label ?? null, limitation]);
        for (const url of targets) await client.query(`INSERT INTO observations(experiment_id, target_url, state) VALUES ($1, $2, 'SUBMITTED')`, [id, url]);
        await client.query(`INSERT INTO experiment_actions(id,experiment_id,kind,completed_at,details) VALUES ($1,$2,'BASELINE_NO_INTERVENTION',clock_timestamp(),$3)`, [randomUUID(), id, { urls: targets.length, network_requests: 0 }]);
        await client.query('COMMIT');
        console.log(JSON.stringify({ experiment_id: id, method: 'baseline', started_at: result.rows[0].started_at, urls: targets.length, state: 'SUBMITTED', final_result: 'UNKNOWN', limitations: limitation }, null, 2));
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } else {
      const { rows, summary } = await report(pool, values.experiment, values.label);
      console.table(summary);
      console.log('Overlapping exposures on the same URL cannot prove method speed or causality. MANUAL_REQUIRED/UNSUPPORTED records are not executed interventions.');
      console.log('API acceptance, verified Googlebot crawl and confirmed indexing are independent. Without verified evidence, crawl/index outcomes remain UNKNOWN.');
      if (!rows.length) console.log('No experiments recorded.');
      if (values.csv) { await writeFile(values.csv, toCsv(rows), { flag: 'wx' }); console.log(`Observation CSV saved: ${values.csv}`); }
      if (values['summary-csv']) { await writeFile(values['summary-csv'], toCsv(summary), { flag: 'wx' }); console.log(`Summary CSV saved: ${values['summary-csv']}`); }
    }
  } finally { await pool.end(); }
}
main().catch(error => {
  console.error(`Command failed: ${describeError(error)}`);
  process.exitCode = 1;
});
