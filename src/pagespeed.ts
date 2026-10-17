import { describeError } from './errors.js';
import type pg from 'pg';
import { publicRequest, resolvePublicDestination } from './http-diagnostic.js';
import { blocked, httpsUrl, liveOutcome, objectJson, requestAction, type Transport } from './live-store.js';
export const pagespeedClassification={
  tool:'PAGESPEED_INSIGHTS_API',interface:'documented REST v5',classification:'DIAGNOSTIC_ONLY',
  service_can_fetch_target:true,fetch_type:'Lighthouse diagnostic rendering when a successful run is returned',
  google_search_discovery_signal:false,googlebot_crawl_evidence:false,indexing_evidence:false,
  documentation:'https://developers.google.com/speed/docs/insights/v5/get-started',
};
export async function runPagespeed(pool:pg.Pool,id:string,target:string,env:NodeJS.ProcessEnv=process.env,transport:Transport=publicRequest,validate=resolvePublicDestination,rateName='pagespeed'){
  try{await validate(httpsUrl(target),AbortSignal.timeout(5000));}
  catch(error){await blocked(pool,id,'Target DNS/HTTPS/public-destination validation failed; tool was not called. '+describeError(error),'Use an authorized public HTTPS target with no private/reserved IP destinations.');return;}
  const slot=await pool.query(`INSERT INTO api_rate_limits(name,next_allowed_at) VALUES($1,clock_timestamp()+interval '60 seconds')
    ON CONFLICT(name) DO UPDATE SET next_allowed_at=EXCLUDED.next_allowed_at WHERE api_rate_limits.next_allowed_at<=clock_timestamp() RETURNING name`,[rateName]);
  if(!slot.rowCount){await blocked(pool,id,'PageSpeed local rate limit is active; no request was sent.','Wait at least 60 seconds; use your own API key and respect project quota. Never rotate accounts.');return;}
  const url=new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  url.searchParams.set('url',target);url.searchParams.set('strategy','mobile');url.searchParams.set('category','PERFORMANCE');
  url.searchParams.set('fields','analysisUTCTimestamp,lighthouseResult(requestedUrl,finalUrl,fetchTime,lighthouseVersion,runtimeError/code,categories/performance/score)');
  if(env.PAGESPEED_API_KEY)url.searchParams.set('key',env.PAGESPEED_API_KEY);
  try{
    const response=await requestAction(pool,id,'PAGESPEED_API_REQUEST',url,{socketTimeoutMs:55000},transport,55000);
    const data=objectJson(response.body);const result=data.lighthouseResult;
    let requestedMatches=false;
    try{requestedMatches=httpsUrl(result?.requestedUrl??'').href===target;}catch{/* no trustworthy matching target */}
    const rendered=requestedMatches&&response.status===200&&!!result&&typeof result.fetchTime==='string'&&typeof result.finalUrl==='string'&&!result.runtimeError;
    let finalUrl:string|undefined;
    try{if(result?.finalUrl)finalUrl=httpsUrl(result.finalUrl).href;}catch{/* untrusted result ignored */}
    const score=result?.categories?.performance?.score;
    await liveOutcome(pool,id,'REQUEST_SENT',{...pagespeedClassification,http_status:response.status,key_configured:!!env.PAGESPEED_API_KEY,diagnostic_render_returned:rendered,diagnostic_final_url:finalUrl,performance_score:typeof score==='number'&&score>=0&&score<=1?score:undefined,error_code:Number.isInteger(data.error?.code)?data.error.code:undefined,reason:rendered?'A diagnostic render response was returned; no Search discovery/crawl/index evidence was obtained.':`Diagnostic request returned HTTP ${response.status}; successful rendering was not established.`,next_configuration_step:response.status===429?'Configure PAGESPEED_API_KEY for your own project and check quota; do not automatically retry.':'Collect separate trusted Googlebot logs and authorized Search Console index evidence.'});
  }catch{await liveOutcome(pool,id,'UNKNOWN',{...pagespeedClassification,reason:'Diagnostic API transport failed/timed out; whether remote rendering happened is UNKNOWN.',next_configuration_step:'Inspect action status. Avoid automatic retries or quota evasion.'});}
}
