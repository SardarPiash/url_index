import type pg from 'pg';
import { performance } from 'node:perf_hooks';
import { beginAction, endAction } from './experiment-store.js';
import { publicRequest, type PublicRequestOptions } from './http-diagnostic.js';

export type Transport = typeof publicRequest;
export type RunState = 'NOT_RUN'|'BLOCKED_CONFIGURATION'|'REQUEST_SENT'|'DISCOVERY_SIGNAL_OBSERVED'|'UNKNOWN';
export async function liveOutcome(pool: pg.Pool, id: string, state: RunState, metadata: Record<string,unknown>, discovery?: string, published = false) {
  await pool.query(`UPDATE observations SET run_state=$2,output_metadata=output_metadata || $3::jsonb,
    discovery_url=COALESCE($4,discovery_url),published_verified=published_verified OR $5 WHERE experiment_id=$1`, [id,state,metadata,discovery ?? null,published]);
  await pool.query('UPDATE experiments SET execution_status=$2 WHERE id=$1', [id,state==='BLOCKED_CONFIGURATION'?'BLOCKED_CONFIGURATION':'COMPLETED']);
}
export async function blocked(pool: pg.Pool, id: string, reason: string, next: string) {
  const action = await beginAction(pool,id,'CONFIGURATION_PREFLIGHT');
  await endAction(pool,action,{request_sent:false,reason,next_configuration_step:next});
  await liveOutcome(pool,id,'BLOCKED_CONFIGURATION',{reason,next_configuration_step:next});
}
export async function requestAction(pool: pg.Pool, id: string, kind: string, url: URL, options: PublicRequestOptions = {}, transport: Transport = publicRequest, timeout = 15000) {
  const display = new URL(url); display.searchParams.delete('key');
  const action = await beginAction(pool,id,kind,{url:display.href,method:options.method ?? 'GET'});
  const started = performance.now();
  let sent = false;
  try {
    const response = await transport(url,AbortSignal.timeout(timeout),true,{...options,onDispatch:()=>{sent=true;}});
    sent=true;
    await endAction(pool,action,{request_sent:sent,response_ms:Math.round(performance.now()-started),body_sha256:response.body_sha256,content_type:response.content_type},response.status,response.status>=400?`HTTP ${response.status}`:null);
    await pool.query('UPDATE observations SET real_request_sent=real_request_sent OR $2,request_status=$3 WHERE experiment_id=$1',[id,sent,response.status]);
    return response;
  } catch {
    await endAction(pool,action,{request_sent:sent,response_ms:Math.round(performance.now()-started)},null,'HTTP operation failed or timed out; sensitive details withheld. Delivery may be unknown.');
    await pool.query('UPDATE observations SET real_request_sent=real_request_sent OR $2 WHERE experiment_id=$1',[id,sent]);
    throw new Error('Transport failed');
  }
}
export function httpsUrl(input: string): URL {
  const url = new URL(input);
  if(url.protocol!=='https:' || url.port || url.username || url.password || url.hash) throw new Error('Invalid secure endpoint');
  return url;
}
export function objectJson(body?: string): any {
  try { const value=JSON.parse(body ?? ''); return value && typeof value==='object' && !Array.isArray(value)?value:{}; } catch { return {}; }
}
