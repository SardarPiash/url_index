import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifact, discoveryEvidence, runDiscovery, type DiscoveryMethod } from '../src/discovery.js';
import { consoleProperty, inspectionInterpretation, runInspection } from '../src/inspection.js';
import { parseLogs, verifyGooglebot, importCrawls, type DnsChecks } from '../src/crawl-monitor.js';
import { createExperiment } from '../src/experiment-store.js';
import { database, migrate } from '../src/db.js';
import { report } from '../src/report.js';
const target = 'https://example.com/product/test?a=1&b=2';
const source = 'https://example.com/source';
const trustedDns: DnsChecks = { reverse: async () => ['crawl-66-249-66-1.googlebot.com.'], forward: async () => ['66.249.66.1'] };

test('sitemap/RSS artifacts escape XML and contain exact target URLs', () => {
  for (const method of ['sitemap','feed','internal-link'] as DiscoveryMethod[]) {
    const generated = artifact(method, target);
    assert.match(generated.text, /&amp;/);
    assert.equal(discoveryEvidence(method, generated.text, source, target).found, true);
  }
  assert.equal(JSON.parse(artifact('redirect', target).text).location, target);
});
test('sitemap indexes return child sources; text mentions are not URL membership', () => {
  assert.deepEqual(discoveryEvidence('sitemap', '<sitemapindex><sitemap><loc>https://example.com/part.xml</loc></sitemap></sitemapindex>', source, target).childSitemaps, ['https://example.com/part.xml']);
  assert.equal(discoveryEvidence('sitemap', `<urlset><url><loc>https://example.com/other</loc><note>${target.replaceAll('&','&amp;')}</note></url></urlset>`, source, target).found, false);
  assert.throws(() => discoveryEvidence('sitemap', '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><urlset/>', source, target));
});
test('HTML verifies actual followable links, entity decoding, base URL and robots rules', () => {
  const url = 'https://example.com/product/test';
  assert.equal(discoveryEvidence('internal-link', '<a href="/product/test">test</a>', source, url).found, true);
  for (const html of ['<script>"https://example.com/product/test"</script>', '<a href="/product/test" rel="nofollow">test</a>', '<base href="https://elsewhere.com/"><a href="/product/test">test</a>', '<meta name="robots" content="nofollow"><a href="/product/test">test</a>']) assert.equal(discoveryEvidence('internal-link', html, source, url).found, false);
});
test('Atom feed accepts entry links rather than channel/self links', () => {
  assert.equal(discoveryEvidence('feed', '<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="https://example.com/product/test"/></entry></feed>', source, 'https://example.com/product/test').found, true);
  assert.equal(discoveryEvidence('feed', '<feed><link href="https://example.com/product/test"/></feed>', source, 'https://example.com/product/test').found, false);
});
test('inspection needs matching PASS canonical evidence; HTTP/allowed indexing alone cannot confirm', () => {
  const wrap = (indexStatusResult: object) => ({ inspectionResult: { indexStatusResult } });
  assert.equal(inspectionInterpretation({}, target).status, 'UNKNOWN');
  assert.equal(inspectionInterpretation(wrap({ indexingState: 'INDEXING_ALLOWED' }), target).status, 'UNKNOWN');
  assert.equal(inspectionInterpretation(wrap({ verdict: 'PASS', indexingState: 'INDEXING_ALLOWED', googleCanonical: 'https://example.com/other' }), target).status, 'UNKNOWN');
  assert.equal(inspectionInterpretation(wrap({ verdict: 'PASS', indexingState: 'INDEXING_ALLOWED', googleCanonical: target }), target).status, 'INDEX_CONFIRMED');
  assert.equal(inspectionInterpretation(wrap({ verdict: 'NEUTRAL' }), target).status, 'NOT_INDEXED');
  assert.throws(() => consoleProperty(target, {}));
  assert.throws(() => consoleProperty(target, { SEARCH_CONSOLE_AUTHORIZED: 'true', SEARCH_CONSOLE_PROPERTY: 'sc-domain:other.com' }));
});
test('Googlebot identity requires common crawler hostname and matching forward lookup', async () => {
  assert.equal((await verifyGooglebot('66.249.66.1', 'Googlebot/2.1', trustedDns)).verified, true);
  for (const name of ['crawl-googlebot.com.evil.com','google-proxy-1.google.com','1.gae.googleusercontent.com']) assert.equal((await verifyGooglebot('66.249.66.1', 'Googlebot/2.1', { ...trustedDns, reverse: async () => [name] })).verified, false);
  assert.equal((await verifyGooglebot('66.249.66.1', 'Googlebot/2.1', { ...trustedDns, forward: async () => ['8.8.8.8'] })).verified, false);
  assert.equal((await verifyGooglebot('66.249.66.1', 'Google-InspectionTool/1.0', trustedDns)).verified, false);
  assert.equal((await verifyGooglebot('127.0.0.1', 'Googlebot/2.1', trustedDns)).verified, false);
});
test('server-log input validates whole batch and rejects future timestamps', () => {
  const row = { timestamp: '2026-01-01T00:00:00Z', remote_ip: '66.249.66.1', url: target, method: 'GET', status: 200, user_agent: 'Googlebot/2.1' };
  assert.equal(parseLogs(JSON.stringify(row)).length, 1);
  assert.throws(() => parseLogs(JSON.stringify({ ...row, timestamp: '2999-01-01T00:00:00Z' })));
  assert.throws(() => parseLogs(JSON.stringify(row) + '\ninvalid'));
});

test('PostgreSQL discovery/actions, read-only inspection and verified log evidence remain independent', { skip: process.env.TEST_DATABASE !== '1' }, async () => {
  const pool = database();
  const ids: string[] = [];
  const create = async (method: string) => { const id = await createExperiment(pool, method, target, 'synthetic-workflow-test'); ids.push(id); return id; };
  try {
    await migrate(pool);
    const prepared = await create('sitemap');
    await runDiscovery(pool, prepared, 'sitemap', target, 'example.com');
    let result = await report(pool, prepared);
    assert.equal(result.rows[0].execution_status, 'MANUAL_REQUIRED');
    assert.equal(result.rows[0].state, 'SUBMITTED');
    for (const method of ['sitemap','internal-link','feed','redirect'] as DiscoveryMethod[]) {
      const id = await create(method);
      await runDiscovery(pool, id, method, target, 'example.com', source, undefined, async () => method === 'redirect' ? { status: 301, location: target } : { status: 200, body: artifact(method, target).text });
      result = await report(pool, id);
      assert.equal(result.rows[0].execution_status, 'COMPLETED');
      assert.equal(result.rows[0].state, 'DISCOVERY_ATTEMPTED');
      assert.equal(result.rows[0].first_verified_crawl_at, null);
      assert.equal(result.rows[0].index_status, 'UNKNOWN');
    }
    const id = await create('url-inspection');
    const env = { SEARCH_CONSOLE_AUTHORIZED: 'true', SEARCH_CONSOLE_PROPERTY: 'sc-domain:example.com' };
    await runInspection(pool, id, target, env, { accessToken: async () => 'mock-token', fetch: async (endpoint, init) => {
      assert.equal(endpoint, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect');
      assert.deepEqual(JSON.parse(init?.body as string), { inspectionUrl: target, siteUrl: env.SEARCH_CONSOLE_PROPERTY, languageCode: 'en-US' });
      return new Response(JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: 'PASS', indexingState: 'INDEXING_ALLOWED', googleCanonical: target, lastCrawlTime: '2020-01-01T00:00:00Z' } }, secret: 'never-store' }), { status: 200 });
    } });
    result = await report(pool, id);
    assert.equal(result.rows[0].index_status, 'INDEX_CONFIRMED');
    assert.equal(result.rows[0].first_verified_crawl_at, null);
    assert.equal(result.rows[0].api_status, 'UNKNOWN');
    await runInspection(pool, id, target, env, { accessToken: async () => 'mock-token', fetch: async () => new Response('{}', { status: 200 }) });
    assert.equal((await report(pool, id)).rows[0].index_status, 'INDEX_CONFIRMED');
    const logId = await create('crawl-monitor');
    const now = new Date().toISOString();
    const entries = parseLogs(JSON.stringify({ timestamp: now, remote_ip: '66.249.66.1', url: target, method: 'GET', status: 200, user_agent: 'Googlebot/2.1' }));
    await importCrawls(pool, logId, target, entries, trustedDns);
    await importCrawls(pool, logId, target, entries, trustedDns);
    result = await report(pool, logId);
    assert.equal(result.rows[0].crawl_status, 'CRAWL_VERIFIED');
    assert.equal(result.rows[0].index_status, 'UNKNOWN');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM evidence_events WHERE experiment_id=$1', [logId])).rows[0].count, 1);
    const historical = await create('crawl-monitor');
    await importCrawls(pool, historical, target, [{ ...entries[0]!, timestamp: '2020-01-01T00:00:00Z' }], trustedDns);
    assert.equal((await report(pool, historical)).rows[0].first_verified_crawl_at, null);
    const missing = await create('url-inspection');
    await runInspection(pool, missing, target, {});
    assert.equal((await report(pool, missing)).rows[0].execution_status, 'MANUAL_REQUIRED');
    const failure = await create('internal-link');
    await runDiscovery(pool, failure, 'internal-link', target, 'example.com', source, undefined, async () => { throw new Error('private token'); });
    assert.equal((await report(pool, failure)).rows[0].execution_status, 'ERROR');
    const actions = await pool.query('SELECT * FROM experiment_actions WHERE experiment_id=ANY($1::uuid[])', [ids]);
    assert.ok(actions.rows.every(row => row.completed_at));
    assert.doesNotMatch(JSON.stringify(actions.rows), /private token|never-store|mock-token/);
  } finally {
    await pool.query('DELETE FROM observations WHERE experiment_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM experiments WHERE id=ANY($1::uuid[])', [ids]);
    await pool.end();
  }
});


test('manual CLI workflows record limitations and operator reports without assuming Google outcomes', { skip: process.env.TEST_DATABASE !== '1' }, async () => {
  const pool = database();
  const ids: string[] = [];
  try {
    const execute = promisify(execFile);
    const variants = [
      ['public-tool','--tool','rich-results-test','--performed-at',new Date().toISOString(),'--http-status','200'],
      ['request-indexing'], ['crawl-monitor'],
      ['assess','--method','google-indexing-api','--page-type','Product'],
    ];
    for (const [command, ...options] of variants) {
      const { stdout } = await execute(process.execPath, ['--import','tsx','src/cli.ts',command!,target,'--allowed-domain','example.com',...options], { env: { ...process.env, SEARCH_CONSOLE_AUTHORIZED: '', SEARCH_CONSOLE_PROPERTY: '', GOOGLE_APPLICATION_CREDENTIALS: '' } });
      const row = JSON.parse(stdout)[0];
      ids.push(row.experiment_id);
      assert.equal(row.index_status, 'UNKNOWN');
      assert.equal(row.api_status, 'UNKNOWN');
      assert.equal(row.execution_status, command === 'assess' ? 'UNSUPPORTED' : command === 'public-tool' ? 'COMPLETED' : 'MANUAL_REQUIRED');
      if (command === 'public-tool') {
        const action = (await pool.query('SELECT * FROM experiment_actions WHERE experiment_id=$1', [row.experiment_id])).rows[0];
        assert.equal(action.http_status, 200);
        assert.equal(action.details.verified, false);
        assert.equal((await report(pool,row.experiment_id)).rows[0].first_verified_crawl_at, null);
      }
    }
  } finally {
    await pool.query('DELETE FROM observations WHERE experiment_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM experiments WHERE id=ANY($1::uuid[])', [ids]);
    await pool.end();
  }
});
