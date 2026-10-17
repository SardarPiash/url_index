import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import { normalizeUrl } from './core.js';
import { UserError } from './errors.js';
import { blocked, httpsUrl, liveOutcome, objectJson, requestAction, type Transport } from './live-store.js';
import { publicRequest } from './http-diagnostic.js';
export type GatewayConfig = { origin:string; target:string; prefix:string; secret:string };
export function gatewayConfig(target: string, env:NodeJS.ProcessEnv=process.env): GatewayConfig {
  if(env.GATEWAY_AUTHORIZED!=='true'||!env.GATEWAY_PUBLIC_ORIGIN||!env.GATEWAY_TARGET_URL||!env.GATEWAY_PROOF_SECRET) throw new UserError('Missing authorized gateway origin, fixed target or proof secret.');
  const origin=httpsUrl(env.GATEWAY_PUBLIC_ORIGIN);
  const destination=httpsUrl(normalizeUrl(env.GATEWAY_TARGET_URL));
  if(origin.pathname!=='/'||origin.search||destination.href!==normalizeUrl(target)||origin.origin===destination.origin||env.GATEWAY_PROOF_SECRET.length<32) throw new UserError('Gateway requires a separate HTTPS origin, exact fixed target and a proof secret of at least 32 characters.');
  const prefix=env.GATEWAY_PATH_PREFIX??'/url-lab';
  if(!/^\/[a-z0-9/_-]+$/i.test(prefix)||prefix.endsWith('/')||prefix.includes('//')) throw new UserError('Invalid gateway path prefix.');
  return {origin:origin.origin,target:destination.href,prefix,secret:env.GATEWAY_PROOF_SECRET};
}
const proof=(config:GatewayConfig,challenge:string)=>createHmac('sha256',config.secret).update(JSON.stringify({origin:config.origin,target:config.target,prefix:config.prefix,challenge})).digest('hex');
export function createGatewayServer(config:GatewayConfig) {
  return createServer((request,response)=>{
    let url:URL;
    try{url=new URL(request.url??'/',config.origin);}catch{response.writeHead(400);response.end();return;}
    response.setHeader('Cache-Control','no-store');
    if(!['GET','HEAD'].includes(request.method??'')){response.writeHead(405);response.end();return;}
    const challenge=url.searchParams.get('challenge');
    if(url.pathname==='/.well-known/url-indexer-lab'&&challenge&&/^[a-f0-9]{32}$/.test(challenge)){
      response.writeHead(200,{'Content-Type':'application/json'});
      response.end(JSON.stringify({origin:config.origin,target:config.target,prefix:config.prefix,challenge,signature:proof(config,challenge)}));return;
    }
    const route=url.pathname.slice(config.prefix.length+1).split('/');
    if(url.pathname.startsWith(config.prefix+'/')&&route.length===2&&['temporary','permanent'].includes(route[0]??'')&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(route[1]??'')&&!url.search){
      response.writeHead(route[0]==='temporary'?302:301,{'Location':config.target,'Content-Type':'text/plain; charset=utf-8'});
      response.end('Authorized URL discovery redirect experiment.\n');return;
    }
    response.writeHead(404,{'Content-Type':'text/plain'});response.end('Not found\n');
  });
}
export async function runGateway(pool:pg.Pool,id:string,target:string,variant:'temporary'|'permanent',env:NodeJS.ProcessEnv=process.env,transport:Transport=publicRequest){
  let config:GatewayConfig;
  try{config=gatewayConfig(target,env);}catch{
    await blocked(pool,id,'Authorized HTTPS gateway is not configured or its preflight configuration is invalid.','Configure GATEWAY_PUBLIC_ORIGIN, GATEWAY_TARGET_URL, GATEWAY_AUTHORIZED=true and GATEWAY_PROOF_SECRET; deploy gateway-serve behind HTTPS.');return;
  }
  const gateway=`${config.origin}${config.prefix}/${variant}/${id}`;
  const chain:Record<string,unknown>[]=[];
  let validProof=false;
  try{
    const challenge=randomBytes(16).toString('hex');
    const proofUrl=new URL('/.well-known/url-indexer-lab',config.origin);proofUrl.searchParams.set('challenge',challenge);
    const response=await requestAction(pool,id,'GATEWAY_OWNERSHIP_PREFLIGHT',proofUrl,{},transport);
    const manifest=objectJson(response.body);
    const expected=proof(config,challenge);
    validProof=response.status===200&&manifest.signature===expected&&manifest.target===config.target&&manifest.origin===config.origin&&manifest.prefix===config.prefix&&manifest.challenge===challenge;
    if(!validProof){await liveOutcome(pool,id,'REQUEST_SENT',{reason:'Gateway endpoint control proof did not match; redirect experiment was not applied.',ownership_verified:false,next_configuration_step:'Deploy this gateway with the same private proof secret and fixed target.'},gateway);return;}
    const seen=new Set<string>();
    let current=gateway;
    let reachedTarget=false;
    let valid=false;
    for(let hop=0;hop<=5;hop++){
      const url=httpsUrl(normalizeUrl(current));
      if(![config.origin,new URL(target).origin].includes(url.origin)||seen.has(url.href)) throw new Error('Redirect loop or out-of-scope destination');
      seen.add(url.href);
      if(url.href===target)reachedTarget=true;
      if(hop)await delay(500);
      const result=await requestAction(pool,id,'GATEWAY_HTTP_HOP',url,{},transport);
      const entry:Record<string,unknown>={url:url.href,status:result.status,body_sha256:result.body_sha256,observed_at:new Date().toISOString()};
      chain.push(entry);
      if([301,302,303,307,308].includes(result.status)&&result.location){
        const location=httpsUrl(normalizeUrl(new URL(result.location,url).href));
        entry.location=location.href;
        if(hop===0&&result.status!==(variant==='temporary'?302:301))throw new Error('Variant status mismatch');
        current=location.href;
      }else{valid=hop>0&&reachedTarget&&result.status>=200&&result.status<300;break;}
    }
    await liveOutcome(pool,id,valid?'DISCOVERY_SIGNAL_OBSERVED':'REQUEST_SENT',{variant,ownership_verified:validProof,redirect_chain:chain,reason:valid?'Verified public HTTPS gateway redirected to the target; Google discovery remains unverified.':'Redirect chain did not satisfy gateway variant/destination checks.',next_configuration_step:valid?'Collect trusted Googlebot logs and authorized Search Console evidence.':'Check redirect configuration and destination responses.'},gateway);
  }catch{
    await liveOutcome(pool,id,'UNKNOWN',{variant,ownership_verified:validProof,redirect_chain:chain,reason:'Gateway preflight/chain failed: invalid destination, loop, HTTPS failure, request failure or hop limit. No Google evidence inferred.',next_configuration_step:'Inspect action statuses and correct the authorized gateway configuration.'},gateway);
  }
}
