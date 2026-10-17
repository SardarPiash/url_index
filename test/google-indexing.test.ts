import { test } from 'node:test';
import { JWT } from 'google-auth-library';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { indexingConfig, loadIndexingCredentials, publishIndexing, indexingEndpoint, indexingDependencies, type IndexingDependencies } from '../src/google-indexing.js';
import { database, migrate } from '../src/db.js';
import { runGoogleExperiment } from '../src/google-experiment.js';
import { report } from '../src/report.js';

const url = 'https://jobs.example.com/openings/42';
const env = {
  GOOGLE_INDEXING_AUTHORIZED: 'true', GOOGLE_INDEXING_PROPERTY: 'sc-domain:example.com',
  GOOGLE_INDEXING_ELIGIBLE_PAGES: JSON.stringify([{ url, pageType: 'JobPosting' }]),
  GOOGLE_APPLICATION_CREDENTIALS: '/secure/service-account.json',
};
const config = indexingConfig(url, env);
const success = () => new Response(JSON.stringify({ urlNotificationMetadata: { url, latestUpdate: { type: 'URL_UPDATED', notifyTime: '2026-10-17T08:00:00.123Z' } }, access_token: 'do-not-store' }), { status: 200 });
const deps = (response: () => Response): IndexingDependencies => ({ accessToken: async () => 'test-token', fetch: async () => response() });

test('eligible page and property checks fail closed for unsupported/arbitrary URLs', () => {
  assert.equal(indexingConfig(url, env).pageType, 'JobPosting');
  assert.throws(() => indexingConfig(url, { ...env, GOOGLE_INDEXING_AUTHORIZED: 'false' }), /ownership/);
  assert.throws(() => indexingConfig('https://evil-example.com/job', env), /outside/);
  assert.throws(() => indexingConfig('https://jobs.example.com/another', env), /allowlist/);
  for (const pageType of ['Product', 'Article', 'BroadcastEvent', 'VideoObject', '']) {
    assert.throws(() => indexingConfig(url, { ...env, GOOGLE_INDEXING_ELIGIBLE_PAGES: JSON.stringify([{ url, pageType }]) }), /Unsupported page type/);
  }
  assert.equal(indexingConfig(url, { ...env, GOOGLE_INDEXING_ELIGIBLE_PAGES: JSON.stringify([{ url, pageType: 'VideoObject/BroadcastEvent' }]) }).pageType, 'VideoObject/BroadcastEvent');
});

test('invalid configuration and missing credentials produce safe actionable errors', () => {
  assert.throws(() => indexingConfig(url, { ...env, GOOGLE_APPLICATION_CREDENTIALS: '' }), /Missing GOOGLE_APPLICATION_CREDENTIALS/);
  assert.throws(() => indexingConfig(url, { ...env, GOOGLE_APPLICATION_CREDENTIALS: './credentials.json' }), /absolute/);
  for (const property of ['', 'bad property', 'sc-domain:example.com/evil', 'https://user:secret@example.com/', 'https://jobs.example.com/openings']) {
    assert.throws(() => indexingConfig(url, { ...env, GOOGLE_INDEXING_PROPERTY: property }));
  }
  assert.throws(() => indexingConfig(url, { ...env, GOOGLE_INDEXING_ELIGIBLE_PAGES: '{secret' }), /JSON array/);
  const prefix = { ...env, GOOGLE_INDEXING_PROPERTY: 'https://jobs.example.com/openings/' };
  assert.equal(indexingConfig(url, prefix).url, url);
  assert.throws(() => indexingConfig('https://jobs.example.com/openings-other/42', prefix), /outside/);
});

test('secure credential loading validates permissions, file type and RSA service-account key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'indexer-auth-test-'));
  const path = join(directory, 'key.json');
  try {
    await assert.rejects(loadIndexingCredentials(path), /Cannot load/);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await writeFile(path, JSON.stringify({ type: 'service_account', client_email: 'test@lab.iam.gserviceaccount.com', private_key: key, token_uri: 'http://malicious.invalid' }), { mode: 0o600 });
    const result = await loadIndexingCredentials(path);
    assert.equal(result.private_key, key);
    assert.equal('token_uri' in result, false);
    await chmod(path, 0o644);
    await assert.rejects(loadIndexingCredentials(path), /mode 600/);
    await chmod(path, 0o600);
    await symlink(path, join(directory, 'link.json'));
    await assert.rejects(loadIndexingCredentials(join(directory, 'link.json')), /Cannot load/);
    await writeFile(path, '{"type":"authorized_user","refresh_token":"secret"}');
    await assert.rejects(loadIndexingCredentials(path), /Cannot load/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Google auth client uses only indexing scope with bounded transport and no redirects/retries', async context => {
  context.mock.method(JWT.prototype, 'authorize', async function (this: JWT) {
    assert.equal(this.email, 'test@lab.iam.gserviceaccount.com');
    assert.equal(this.key, 'synthetic-key');
    assert.deepEqual(this.scopes, ['https://www.googleapis.com/auth/indexing']);
    assert.equal(this.subject, undefined);
    assert.equal(this.transporter.defaults.timeout, 10000);
    assert.equal(this.transporter.defaults.retry, false);
    assert.equal(this.transporter.defaults.maxRedirects, 0);
    assert.ok(this.transporter.defaults.signal);
    return { access_token: 'synthetic-access-token' };
  });
  const dependencies = indexingDependencies({ client_email: 'test@lab.iam.gserviceaccount.com', private_key: 'synthetic-key' });
  assert.equal(await dependencies.accessToken(new AbortController().signal), 'synthetic-access-token');
});

test('HTTP 200 sends documented request and produces API_ACCEPTED only with sanitized metadata', async () => {
  let called = 0;
  const result = await publishIndexing(config, {
    accessToken: async () => 'test-token',
    fetch: async (endpoint, options) => {
      called++;
      assert.equal(endpoint, indexingEndpoint);
      assert.equal(options?.method, 'POST');
      assert.equal(options?.redirect, 'error');
      assert.equal((options?.headers as Record<string,string>).Authorization, 'Bearer test-token');
      assert.equal((options?.headers as Record<string,string>)['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(options?.body as string), { url, type: 'URL_UPDATED' });
      return success();
    },
  });
  assert.equal(called, 1);
  assert.equal(result.state, 'API_ACCEPTED');
  assert.equal(result.api_status, 'API_ACCEPTED');
  assert.equal(result.request_status, 200);
  assert.ok(result.request_started_at && result.request_completed_at && result.api_accepted_at);
  assert.equal(result.api_metadata.notify_time, '2026-10-17T08:00:00.123Z');
  assert.doesNotMatch(JSON.stringify(result), /do-not-store|test-token|INDEX_CONFIRMED|CRAWL_VERIFIED/);
});

test('API failure records HTTP status and allowlisted error status without secrets or retries', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    let calls = 0;
    const result = await publishIndexing(config, deps(() => {
      calls++;
      return new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'Bearer secret', details: ['private-key'] } }), { status });
    }));
    assert.equal(calls, 1);
    assert.equal(result.state, 'ERROR');
    assert.equal(result.request_status, status);
    assert.equal(result.api_accepted_at, null);
    assert.equal(result.api_metadata.google_error_status, 'PERMISSION_DENIED');
    assert.doesNotMatch(JSON.stringify(result), /Bearer secret|private-key/);
  }
});

test('authentication and transport failures are sanitized; failed auth never publishes', async () => {
  let calls = 0;
  const auth = await publishIndexing(config, { accessToken: async () => { throw new Error('secret private key'); }, fetch: async () => { calls++; return success(); } });
  assert.equal(calls, 0);
  assert.equal(auth.request_started_at, null);
  assert.equal(auth.request_status, null);
  assert.match(auth.error!, /authentication failed/);
  const network = await publishIndexing(config, { accessToken: async () => 'token', fetch: async () => { throw new Error('secret Authorization'); } });
  assert.equal(network.state, 'ERROR');
  assert.match(network.error!, /delivery may be unknown/);
  assert.doesNotMatch(JSON.stringify([auth, network]), /secret|Authorization/);
});

test('200 with malformed response body still means acceptance only; raw metadata is discarded', async () => {
  const result = await publishIndexing(config, deps(() => new Response('invalid secret JSON', { status: 200 })));
  assert.equal(result.api_status, 'API_ACCEPTED');
  assert.equal(result.api_metadata.notify_time, undefined);
  assert.doesNotMatch(JSON.stringify(result), /invalid secret/);
});

test('CLI refuses missing Google configuration without any live request or credential fallback', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'google-indexing-api', url], { encoding: 'utf8', env: { ...process.env, GOOGLE_INDEXING_AUTHORIZED: '', GOOGLE_APPLICATION_CREDENTIALS: '' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GOOGLE_INDEXING_AUTHORIZED/);
});

test('real PostgreSQL integration persists mocked acceptance/failure without changing crawl/index evidence', { skip: process.env.TEST_DATABASE !== '1' }, async () => {
  const pool = database();
  const ids: string[] = [];
  try {
    await migrate(pool);
    const before = await pool.query("SELECT count(*)::int AS count FROM experiments WHERE method='baseline'");
    for (const status of [200, 403, null]) {
      const mocked = status === null ? { accessToken: async () => { throw new Error('synthetic authentication failure'); }, fetch: async () => { throw new Error('Must never publish'); } } : deps(() => status === 200 ? success() : new Response('{}', { status }));
      const experiment = await runGoogleExperiment(pool, config, mocked, 'mock-integration-only');
      ids.push(experiment.experiment_id);
      const result = await report(pool, experiment.experiment_id);
      const row = result.rows[0]!;
      assert.equal(row.request_status, status);
      assert.equal(row.api_status, status === 200 ? 'API_ACCEPTED' : 'ERROR');
      assert.equal(row.state, status === 200 ? 'API_ACCEPTED' : 'ERROR');
      assert.equal(row.crawl_status, 'UNKNOWN');
      assert.equal(row.index_status, 'UNKNOWN');
      assert.equal(row.final_result, 'UNKNOWN');
      assert.equal(row.first_verified_crawl_at, null);
      assert.equal(row.index_confirmed_at, null);
      assert.equal(result.summary[0]!.api_accepted, status === 200 ? 1 : 0);
      assert.equal(result.summary[0]!.confirmed_indexed, 0);
      assert.equal(result.summary[0]!.verified_crawls, 0);
      assert.equal(result.summary[0]!.errors, status === 200 ? 0 : 1);
    }
    const after = await pool.query("SELECT count(*)::int AS count FROM experiments WHERE method='baseline'");
    assert.equal(before.rows[0].count, after.rows[0].count);
  } finally {
    await pool.query('DELETE FROM observations WHERE experiment_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM experiments WHERE id=ANY($1::uuid[])', [ids]);
    await pool.end();
  }
});
