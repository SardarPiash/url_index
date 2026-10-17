import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isPublicAddress, authorizedUrl, httpDiagnostic } from '../src/http-diagnostic.js';
import { describeError } from '../src/errors.js';

test('bare URL gives the exact syntax fix before any database access', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'https://example.com/a'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgresql://secret:password@127.0.0.1:1/private' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing command.*baseline URL/);
  assert.doesNotMatch(result.stderr, /password|postgresql/);
});

test('untrusted errors do not disclose credentials or database detail', () => {
  assert.equal(describeError({ code: '28P01', message: 'password=secret', detail: 'token=secret' }), 'PostgreSQL authentication failed. Check DATABASE_URL. [28P01]');
  assert.match(describeError({ code: '42P01' }), /npm run db:migrate/);
  assert.doesNotMatch(describeError(new Error('postgresql://user:secret@host/db')), /secret/);
});

test('SSRF rejects loopback, private, metadata, mapped IPv6 and reserved addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '224.0.0.1', '192.0.2.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.throws(() => authorizedUrl('https://other.example/a', 'example.com'));
  assert.throws(() => authorizedUrl('https://example.com:8443/a', 'example.com'));
  assert.throws(() => authorizedUrl('https://user:secret@example.com/a', 'example.com'));
});

test('HTTP diagnostic records redirect chain and final status without indexing fields', async () => {
  const seen: string[] = [];
  const result = await httpDiagnostic('https://example.com/a', 'example.com', async url => {
    seen.push(url.href);
    return url.pathname === '/a' ? { status: 302, location: '/b' } : { status: 200 };
  });
  assert.deepEqual(seen, ['https://example.com/a', 'https://example.com/b']);
  assert.equal(result.kind, 'APPLICATION_HTTP_FETCH');
  assert.equal(result.http_status, 200);
  assert.equal(result.final_url, 'https://example.com/b');
  assert.equal(result.redirects.length, 1);
  assert.equal(result.error, null);
  assert.ok(result.response_ms >= 0);
  assert.equal('first_verified_crawl_at' in result, false);
});

test('cross-domain redirects are recorded but never requested; transport errors recorded safely', async () => {
  let calls = 0;
  const result = await httpDiagnostic('https://example.com/a', 'example.com', async () => {
    calls++;
    return { status: 302, location: 'http://169.254.169.254/metadata' };
  });
  assert.equal(calls, 1);
  assert.match(result.error!, /restricted/);
  const failure = await httpDiagnostic('https://example.com/a', 'example.com', async () => { throw Object.assign(new Error('secret'), { code: 'ECONNRESET' }); });
  assert.match(failure.error!, /ECONNRESET/);
  assert.equal(failure.http_status, null);
  assert.doesNotMatch(failure.error!, /secret/);
});
