import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse as parseHtml } from 'parse5';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type pg from 'pg';
import { normalizeUrl } from './core.js';
import { authorizedUrl, publicRequest } from './http-diagnostic.js';
import { describeError, UserError } from './errors.js';
import { beginAction, endAction, finishExperiment } from './experiment-store.js';

export const discoveryMethods = ['sitemap', 'internal-link', 'redirect', 'feed'] as const;
export type DiscoveryMethod = typeof discoveryMethods[number];
export function xmlEscape(value: string) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
export function artifact(method: DiscoveryMethod, target: string) {
  const escaped = xmlEscape(target);
  if (method === 'sitemap') return { name: 'sitemap.xml', text: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escaped}</loc></url></urlset>\n` };
  if (method === 'internal-link') return { name: 'internal-link.html', text: `<a href="${escaped}">Product details</a>\n` };
  if (method === 'feed') return { name: 'feed.xml', text: `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Authorized discovery experiment</title><link>${escaped}</link><description>Test feed</description><item><title>Product details</title><link>${escaped}</link><guid isPermaLink="true">${escaped}</guid></item></channel></rss>\n` };
  // A fixed JSON recipe avoids injecting URLs into server configuration syntax.
  return { name: 'redirect.json', text: JSON.stringify({ status: 301, location: target, instructions: 'Configure a separate source path on your own site to return this status and Location. Do not redirect the target URL itself.' }, null, 2) + '\n' };
}

export function htmlRobotsDirectives(body:string):string[]{
  const stack:any[]=[parseHtml(body)];const directives:string[]=[];
  while(stack.length){const node=stack.pop()!;
    if(node.tagName==='meta'){
      const attrs=Object.fromEntries((node.attrs??[]).map((entry:any)=>[entry.name,entry.value]));
      if(['robots','googlebot'].includes(String(attrs.name??'').toLowerCase()))directives.push(...String(attrs.content??'').toLowerCase().split(/[\s,]+/));
    }
    for(const child of node.childNodes??[])stack.push(child);
  }
  return directives;
}

function xml(body: string): any {
  if (/<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true) throw new UserError('Invalid XML or prohibited XML entities/DOCTYPE.');
  return new XMLParser({ ignoreAttributes: false, parseTagValue: false, removeNSPrefix: true }).parse(body);
}
function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function urlEquals(input: unknown, target: string, base: string): boolean {
  try { return typeof input === 'string' && normalizeUrl(new URL(input.trim(), base).href) === target; } catch { return false; }
}
export function discoveryEvidence(method: DiscoveryMethod, body: string, source: string, target: string): { found: boolean; childSitemaps: string[] } {
  if (method === 'internal-link') {
    const document = parseHtml(body);
    const nodes: any[] = [];
    const pending: any[] = [document];
    while (pending.length) { const node = pending.pop()!; nodes.push(node); pending.push(...[...(node.childNodes ?? [])].reverse()); }
    const attr = (node: any, name: string): string => node.attrs?.find((value: any) => value.name === name)?.value ?? '';
    const base = nodes.find(node => node.tagName === 'base' && attr(node, 'href'));
    const baseUrl = base ? new URL(attr(base, 'href'), source).href : source;
    const nofollow = nodes.some(node => node.tagName === 'meta' && ['robots', 'googlebot'].includes(attr(node, 'name').toLowerCase()) && /(?:^|[\s,])(?:nofollow|none)(?:$|[\s,])/i.test(attr(node, 'content')));
    return { found: !nofollow && nodes.some(node => node.tagName === 'a' && !/\b(?:nofollow|sponsored|ugc)\b/i.test(attr(node, 'rel')) && urlEquals(attr(node, 'href'), target, baseUrl)), childSitemaps: [] };
  }
  const parsed = xml(body);
  if (method === 'sitemap') return { found: list<any>(parsed.urlset?.url).some(item => urlEquals(item.loc, target, source)), childSitemaps: list<any>(parsed.sitemapindex?.sitemap).map(item => item.loc).filter((item): item is string => typeof item === 'string') };
  if (method === 'feed') {
    const contentLink = (value: any): boolean => typeof value === 'string' ? discoveryEvidence('internal-link',value,source,target).found : value && typeof value['#text'] === 'string' ? discoveryEvidence('internal-link',value['#text'],source,target).found : false;
    const rss = list<any>(parsed.rss?.channel?.item).some(item => urlEquals(item.link, target, source) || contentLink(item.description) || contentLink(item.encoded));
    const atom = list<any>(parsed.feed?.entry).some(item => list<any>(item.link).some(link => (!link['@_rel'] || link['@_rel'] === 'alternate') && urlEquals(link['@_href'], target, source)) || contentLink(item.content) || contentLink(item.summary));
    return { found: rss || atom, childSitemaps: [] };
  }
  return { found: false, childSitemaps: [] };
}

export async function runDiscovery(pool: pg.Pool, id: string, method: DiscoveryMethod, target: string, domain: string, source?: string, output?: string, transport = publicRequest) {
  authorizedUrl(target, domain);
  if (!source) {
    const action = await beginAction(pool, id, 'PREPARE_DISCOVERY', { method });
    try {
      const generated = artifact(method, target);
      let path: string | undefined;
      if (output) { await mkdir(output, { recursive: true }); path = join(output, `${id}-${generated.name}`); await writeFile(path, generated.text, { flag: 'wx' }); }
      await endAction(pool, action, { artifact_path: path, artifact: path ? undefined : generated.text, intervention: 'NOT_PUBLISHED', reason: 'Publish on your authorized website, then rerun with --experiment UUID --source URL. No remote website was modified.' });
      await finishExperiment(pool, id, 'MANUAL_REQUIRED');
      return;
    } catch (error) { await endAction(pool, action, {}, null, describeError(error)); await finishExperiment(pool, id, 'ERROR', 'ERROR', describeError(error)); return; }
  }
  if (normalizeUrl(source) === target && ['internal-link', 'redirect'].includes(method)) throw new UserError('Source must differ from target for this discovery method.');
  const queue = [authorizedUrl(source, domain).href];
  const seen = new Set<string>();
  let found = false;
  let lastStatus: number | null = null;
  try {
    while (queue.length && seen.size < 6 && !found) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      authorizedUrl(current, domain);
      if (seen.size) await delay(500);
      seen.add(current);
      const action = await beginAction(pool, id, 'VERIFY_PUBLISHED_SOURCE', { method, source: current, intervention: 'OBSERVATION_ONLY' });
      try {
        lastStatus = null;
        const response = await transport(new URL(current), AbortSignal.timeout(10000), method !== 'redirect');
        lastStatus = response.status;
        let children: string[] = [];
        if (method === 'redirect') {
          found = [301, 302, 303, 307, 308].includes(response.status) && !!response.location && urlEquals(response.location, target, current);
        } else if (response.status === 200) {
          const checked = discoveryEvidence(method, response.body ?? '', current, target);
          found = checked.found;
          children = checked.childSitemaps;
          // Only follow sitemap indexes, bounded and restricted to this authorized hostname.
          for (const child of children.slice(0, 6)) { try { const next = authorizedUrl(new URL(child, current).href, domain); if (!seen.has(next.href) && queue.length < 6) queue.push(next.href); } catch { /* Out-of-scope sitemap links are never fetched. */ } }
        }
        await endAction(pool, action, { target_found: found, body_sha256:response.body_sha256, content_type:response.content_type, child_sitemaps_seen: children.length, application_fetch: true, response_location: response.location ? normalizeUrl(new URL(response.location, current).href) : null }, response.status, response.status >= 400 ? `Discovery source returned HTTP ${response.status}.` : null);
      } catch (error) { await endAction(pool, action, {}, lastStatus, describeError(error)); throw error; }
    }
    const action = await beginAction(pool, id, 'DISCOVERY_OBSERVATION', { found, checked_sources: seen.size, reason: found ? 'Target exposure verified by our application; publication time and Google discovery remain unverified.' : 'No matching target exposure verified within bounds; publish/configure a source and verify it.' });
    await endAction(pool, action, {});
    await finishExperiment(pool, id, found ? 'COMPLETED' : 'MANUAL_REQUIRED', found ? 'DISCOVERY_ATTEMPTED' : 'SUBMITTED', null, lastStatus);
  } catch (error) { await finishExperiment(pool, id, 'ERROR', 'ERROR', describeError(error), lastStatus); }
}
