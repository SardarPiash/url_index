import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { JWT } from 'google-auth-library';
import { normalizeUrl } from './core.js';
import { UserError } from './errors.js';

export const indexingEndpoint = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
export const indexingLimitation = 'Indexing API acceptance is not Googlebot crawl or indexing evidence. Eligible page type and property authorization are operator declarations; Google enforces authorization. Crawl and index status remain UNKNOWN without separate verified evidence.';
const pageTypes = ['JobPosting', 'VideoObject/BroadcastEvent'] as const;
export type IndexingConfig = { property: string; url: string; pageType: typeof pageTypes[number]; credentialPath: string };

export function coveredByProperty(url: URL, property: string): boolean {
  if (property.startsWith('sc-domain:')) {
    const domain = property.slice(10);
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) throw new UserError('Invalid GOOGLE_INDEXING_PROPERTY domain property.');
    return url.hostname === domain.toLowerCase() || url.hostname.endsWith('.' + domain.toLowerCase());
  }
  let prefix: URL;
  try { prefix = new URL(property); } catch { throw new UserError('Invalid GOOGLE_INDEXING_PROPERTY; use sc-domain:example.com or an HTTP(S) URL prefix.'); }
  if (!['http:', 'https:'].includes(prefix.protocol) || prefix.username || prefix.password || prefix.search || prefix.hash || prefix.port || !prefix.pathname.endsWith('/')) {
    throw new UserError('URL-prefix property must use HTTP(S), standard ports, no credentials/query/fragment, and a trailing slash.');
  }
  return url.origin === prefix.origin && url.pathname.startsWith(prefix.pathname);
}

export function indexingConfig(input: string, env: NodeJS.ProcessEnv = process.env): IndexingConfig {
  if (env.GOOGLE_INDEXING_AUTHORIZED !== 'true') throw new UserError('Set GOOGLE_INDEXING_AUTHORIZED=true only after verifying property ownership and granting the service account owner access.');
  const property = env.GOOGLE_INDEXING_PROPERTY;
  if (!property) throw new UserError('Missing GOOGLE_INDEXING_PROPERTY.');
  const url = normalizeUrl(input);
  if (!coveredByProperty(new URL(url), property)) throw new UserError('Target URL is outside the configured authorized property.');
  let pages: unknown;
  try { pages = JSON.parse(env.GOOGLE_INDEXING_ELIGIBLE_PAGES ?? ''); } catch { throw new UserError('GOOGLE_INDEXING_ELIGIBLE_PAGES must be a JSON array of {url,pageType} entries.'); }
  if (!Array.isArray(pages) || !pages.length || pages.length > 1000) throw new UserError('Configure 1–1000 eligible pages explicitly.');
  const eligible = new Map<string, typeof pageTypes[number]>();
  for (const entry of pages) {
    if (!entry || typeof entry.url !== 'string' || !pageTypes.includes(entry.pageType)) throw new UserError('Unsupported page type: only JobPosting or VideoObject/BroadcastEvent is eligible.');
    const normalized = normalizeUrl(entry.url);
    if (!coveredByProperty(new URL(normalized), property) || eligible.has(normalized)) throw new UserError('Eligible pages must be unique and inside the authorized property.');
    eligible.set(normalized, entry.pageType);
  }
  const pageType = eligible.get(url);
  if (!pageType) throw new UserError('URL is not in the explicit eligible-page allowlist. No request was made.');
  const credentialPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialPath) throw new UserError('Missing GOOGLE_APPLICATION_CREDENTIALS. Configure a private service-account JSON file explicitly.');
  if (!isAbsolute(credentialPath)) throw new UserError('GOOGLE_APPLICATION_CREDENTIALS must be an absolute file path.');
  return { property, url, pageType, credentialPath };
}

export type ServiceCredentials = { client_email: string; private_key: string };
export async function loadIndexingCredentials(path: string): Promise<ServiceCredentials> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('insecure file');
    const key = JSON.parse(await handle.readFile('utf8'));
    if (key.type !== 'service_account' || typeof key.client_email !== 'string' || !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(key.client_email) || typeof key.private_key !== 'string') throw new Error('invalid credentials');
    const privateKey = createPrivateKey(key.private_key);
    if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('invalid key');
    // Never pass credential-supplied endpoint URLs, subjects, or quota projects to auth.
    return { client_email: key.client_email, private_key: key.private_key };
  } catch { throw new UserError('Cannot load service-account credentials. Check file existence, ownership, mode 600, JSON type, and RSA private key. No credential details were logged.'); }
  finally { await handle?.close(); }
}

export type IndexingDependencies = {
  accessToken: (signal: AbortSignal) => Promise<string>;
  fetch: typeof fetch;
};
export function indexingDependencies(credentials: ServiceCredentials): IndexingDependencies {
  return {
    accessToken: async signal => {
      const client = new JWT({ email: credentials.client_email, key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/indexing'],
        transporterOptions: { timeout: 10000, retry: false, maxRedirects: 0, maxContentLength: 65536, signal },
      });
      const tokens = await client.authorize();
      if (!tokens.access_token) throw new Error('No access token');
      return tokens.access_token;
    },
    fetch: globalThis.fetch,
  };
}

export type IndexingResult = {
  state: 'API_ACCEPTED' | 'ERROR'; api_status: 'API_ACCEPTED' | 'ERROR';
  request_started_at: string | null; request_completed_at: string;
  request_status: number | null; api_accepted_at: string | null;
  error: string | null; api_metadata: Record<string, unknown>;
};

export async function safeJson(response: Response): Promise<Record<string, any>> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 65536) { await reader.cancel(); return {}; }
      chunks.push(chunk.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
  finally { reader.releaseLock(); }
}

export async function publishIndexing(config: IndexingConfig, dependencies: IndexingDependencies): Promise<IndexingResult> {
  const signal = AbortSignal.timeout(20000);
  let requestTime: string | null = null;
  let status: number | null = null;
  let phase = 'authentication';
  const metadata: Record<string, unknown> = { notification_type: 'URL_UPDATED', property: config.property, page_type: config.pageType };
  try {
    const token = await dependencies.accessToken(signal);
    if (!token || /[\r\n]/.test(token)) throw new Error('Invalid token');
    signal.throwIfAborted();
    phase = 'publish';
    requestTime = new Date().toISOString();
    const response = await dependencies.fetch(indexingEndpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: config.url, type: 'URL_UPDATED' }),
    });
    status = response.status;
    const data = await safeJson(response);
    // Exact allowlists: never persist raw responses, error messages, headers, URLs or auth objects.
    const notification = data.urlNotificationMetadata?.latestUpdate;
    if (notification?.type === 'URL_UPDATED') metadata.response_notification_type = 'URL_UPDATED';
    if (typeof notification?.notifyTime === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(notification.notifyTime)) metadata.notify_time = notification.notifyTime;
    const errorStatus = data.error?.status;
    if (['INVALID_ARGUMENT', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'UNAVAILABLE'].includes(errorStatus)) metadata.google_error_status = errorStatus;
    const accepted = status === 200;
    const completed = new Date().toISOString();
    return { state: accepted ? 'API_ACCEPTED' : 'ERROR', api_status: accepted ? 'API_ACCEPTED' : 'ERROR', request_started_at: requestTime, request_completed_at: completed, request_status: status,
      api_accepted_at: accepted ? completed : null, error: accepted ? null : `Google Indexing API returned HTTP ${status}. Check authorization, eligibility, and quota.`, api_metadata: metadata };
  } catch {
    return { state: 'ERROR', api_status: 'ERROR', request_started_at: requestTime, request_completed_at: new Date().toISOString(), request_status: status, api_accepted_at: null,
      error: signal.aborted ? 'Google API operation timed out (20 seconds); delivery may be unknown.' : phase === 'authentication' ? 'Google authentication failed. Check service-account authorization and credentials; sensitive details withheld.' : 'Google API transport failed; delivery may be unknown. Sensitive details withheld.', api_metadata: metadata };
  }
}
