import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import ipaddr from 'ipaddr.js';
import { normalizeUrl } from './core.js';
import { UserError, describeError } from './errors.js';

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

export function authorizedUrl(input: string, domain: string): URL {
  const url = new URL(normalizeUrl(input));
  if (url.hostname !== domain || url.port) throw new UserError('Fetch restricted to the exact --allowed-domain hostname and standard HTTP(S) ports.');
  return url;
}

export async function resolvePublicDestination(url:URL,signal:AbortSignal){
  signal.throwIfAborted();
  const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const aborted = () => reject(new UserError('HTTP request deadline exceeded.'));
    signal.addEventListener('abort', aborted, { once: true });
    lookup(url.hostname, { all: true }).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new UserError('SSRF protection blocked a non-public destination.');
  signal.throwIfAborted();
  return addresses[0]!;
}

export type PublicRequestOptions = { method?: 'GET' | 'POST'; headers?: Record<string,string>; body?: string; onDispatch?: () => void; socketTimeoutMs?: number };
export async function publicRequest(url: URL, signal: AbortSignal, readBody = false, options: PublicRequestOptions = {}) {
  const pinned=await resolvePublicDestination(url,signal);
  return new Promise<{ status: number; location?: string; body?: string; body_sha256?: string; content_type?: string; robots_tag?: string }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: options.method ?? 'GET', signal, agent: false, family: pinned.family,
      headers: { 'user-agent': 'URL-Indexer-Lab-HTTP-Diagnostic/0.1', accept: '*/*', ...options.headers },
      // Pin the validated IP; preserve Host and TLS SNI from the original URL.
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    }, response => {
      if (!readBody) {
        resolve({ status: response.statusCode!, location: response.headers.location });
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) { response.destroy(new UserError('Discovery response exceeds 1 MiB.')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new UserError('Discovery response was interrupted.')));
      response.on('end', () => resolve({ status: response.statusCode!, location: response.headers.location, body: Buffer.concat(chunks).toString('utf8'), body_sha256: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), content_type: response.headers['content-type']?.slice(0,128), robots_tag: String(response.headers['x-robots-tag'] ?? '').slice(0,512) }));
    });
    request.setTimeout(options.socketTimeoutMs ?? 5000, () => request.destroy(new UserError('HTTP socket timed out.')));
    request.on('error', reject);
    request.on('finish', () => options.onDispatch?.());
    request.end(options.body);
  });
}

export async function httpDiagnostic(input: string, domain: string, transport = publicRequest) {
  let current = authorizedUrl(input, domain);
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const hops: { url: string; status: number; location?: string; response_ms: number }[] = [];
  let error: string | null = null;
  try {
    for (let index = 0; index <= 5; index++) {
      const before = performance.now();
      const result = await Promise.race([
        transport(current, controller.signal),
        new Promise<never>((_resolve, reject) => {
          if (controller.signal.aborted) reject(new UserError('HTTP diagnostic exceeded 15 seconds.'));
          else controller.signal.addEventListener('abort', () => reject(new UserError('HTTP diagnostic exceeded 15 seconds.')), { once: true });
        }),
      ]);
      hops.push({ url: current.href, status: result.status, location: result.location ? new URL(result.location, current).href : undefined, response_ms: Math.round(performance.now() - before) });
      if (![301, 302, 303, 307, 308].includes(result.status) || !result.location) break;
      if (index === 5) throw new UserError('Redirect limit exceeded (5).');
      const next = authorizedUrl(new URL(result.location, current).href, domain);
      await delay(500, undefined, { signal: controller.signal }); // No retries; bounded redirect rate.
      current = next;
    }
  } catch (caught) { error = controller.signal.aborted ? 'HTTP diagnostic exceeded 15 seconds.' : describeError(caught); }
  finally { clearTimeout(timer); }
  return {
    kind: 'APPLICATION_HTTP_FETCH', target_url: normalizeUrl(input), allowed_domain: domain,
    final_url: current.href, http_status: hops.at(-1)?.status ?? null,
    redirects: hops.filter(hop => [301, 302, 303, 307, 308].includes(hop.status)), hops,
    response_ms: Math.round(performance.now() - started), error,
    limitations: 'Our application HTTP fetch (GET response headers), not a Googlebot crawl. No indexing evidence. HTTP errors and acceptance do not establish indexing.',
  };
}
