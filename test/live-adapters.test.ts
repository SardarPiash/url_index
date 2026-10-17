import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac,randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { gatewayConfig,createGatewayServer,runGateway } from '../src/gateway.js';
import { publicationPlan,generatedResource,runPublishing,verifyPublication } from '../src/publishing.js';
import { runPagespeed } from '../src/pagespeed.js';
import { discoveryEvidence,xmlEscape } from '../src/discovery.js';
import { createExperiment } from '../src/experiment-store.js';
import { database,migrate } from '../src/db.js';
import { report } from '../src/report.js';
import type { Transport } from '../src/live-store.js';
const target='https://beautyhallbd.com/product/ceramide-face-mask-30ml/';
const gatewayEnv={GATEWAY_PUBLIC_ORIGIN:'https://gateway.example.com',GATEWAY_TARGET_URL:target,GATEWAY_AUTHORIZED:'true',GATEWAY_PROOF_SECRET:'synthetic-private-proof-secret-at-least-32'};
const response=(status:number,body='',location?:string)=>({status,body,location});

test('gateway configuration rejects missing authorization, HTTP, loops and weak secrets',()=>{
  assert.throws(()=>gatewayConfig(target,{}));
  assert.throws(()=>gatewayConfig(target,{...gatewayEnv,GATEWAY_PUBLIC_ORIGIN:'http://gateway.example.com'}));
  assert.throws(()=>gatewayConfig(target,{...gatewayEnv,GATEWAY_PUBLIC_ORIGIN:'https://beautyhallbd.com'}));
  assert.throws(()=>gatewayConfig(target,{...gatewayEnv,GATEWAY_PROOF_SECRET:'weak'}));
  assert.equal(gatewayConfig(target,gatewayEnv).target,target);
});
test('local-only gateway server actually returns temporary/permanent redirects and a control proof',async()=>{
  const server=createGatewayServer(gatewayConfig(target,gatewayEnv));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');
  const origin=`http://127.0.0.1:${address.port}`;
  try{
    for(const [variant,status] of [['temporary',302],['permanent',301]] as const){
      const result=await fetch(`${origin}/url-lab/${variant}/${randomUUID()}`,{redirect:'manual'});
      assert.equal(result.status,status);assert.equal(result.headers.get('location'),target);await result.text();
    }
    const manifest=await (await fetch(`${origin}/.well-known/url-indexer-lab?challenge=${'a'.repeat(32)}`)).json();
    assert.match(manifest.signature,/^[a-f0-9]{64}$/);assert.equal(manifest.target,target);
    assert.doesNotMatch(JSON.stringify(manifest),/synthetic-private/);
    assert.equal((await fetch(`${origin}/url-lab/temporary/${randomUUID()}?url=https://evil.example`,{redirect:'manual'})).status,404);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('publication review hashes bind exact site/variant/content and previews do not reveal URL credentials',()=>{
  const plan=publicationPlan('wordpress',target,'link',{CMS_URL:'https://owned.example/'});
  assert.notEqual(plan.confirmation_sha256,publicationPlan('wordpress',target,'rss',{CMS_URL:'https://owned.example/'}).confirmation_sha256);
  assert.notEqual(plan.confirmation_sha256,publicationPlan('wordpress',target,'link',{CMS_URL:'https://other.example/'}).confirmation_sha256);
  assert.doesNotMatch(JSON.stringify(publicationPlan('wordpress',target,'link',{CMS_URL:'https://user:secret@owned.example/?token=secret'})),/secret|user:/);
  assert.match(plan.html,/transparent, authorized experiment/);
});
test('RSS/Atom generation includes target; external-site sitemap lists the owned discovery post',()=>{
  const post='https://owned.example/posts/reference';
  for(const variant of ['rss','atom'] as const)assert.equal(discoveryEvidence('feed',generatedResource(variant,target,post),post,target).found,true);
  const sitemap=generatedResource('sitemap',target,post);
  assert.equal(discoveryEvidence('sitemap',sitemap,post,post).found,true);
  assert.equal(discoveryEvidence('sitemap',sitemap,post,target).found,false);
  const rss=`<rss><channel><item><link>${post}</link><description>${xmlEscape(`<a href="${target}">product</a>`)}</description></item></channel></rss>`;
  assert.equal(discoveryEvidence('feed',rss,post,target).found,true);
});

test('real PostgreSQL live-adapter integration uses MOCKED transports, preserves evidence separation and prevents duplicate publication',{skip:process.env.TEST_DATABASE!=='1'},async()=>{
  const pool=database();const ids:string[]=[];const rateKeys:string[]=[];
  const create=async(method:string,variant='default')=>{const id=await createExperiment(pool,method,target,'synthetic-live-adapter-fixture',variant);ids.push(id);return id;};
  try{
    await migrate(pool);
    let calls=0;
    const never:Transport=async()=>{calls++;throw new Error('must not call');};
    const missingGateway=await create('redirect-gateway','temporary');await runGateway(pool,missingGateway,target,'temporary',{},never);
    const missingCms=await create('cms-publish','link');await runPublishing(pool,missingCms,target,'wordpress','link',undefined,false,{},never);
    const missingBlog=await create('blogger-publish','link');await runPublishing(pool,missingBlog,target,'blogger','link',undefined,false,{},never);
    assert.equal(calls,0);
    for(const id of [missingGateway,missingCms,missingBlog]){const row=(await report(pool,id)).rows[0];assert.equal(row.run_state,'BLOCKED_CONFIGURATION');assert.equal(row.real_request_sent,false);}
    const gconfig=gatewayConfig(target,gatewayEnv);
    for(const variant of ['temporary','permanent'] as const){
      const id=await create('redirect-gateway',variant);
      const transport:Transport=async(url,_signal,_read,options)=>{
        options?.onDispatch?.();
        if(url.pathname==='/.well-known/url-indexer-lab'){
          const challenge=url.searchParams.get('challenge');
          const signature=createHmac('sha256',gconfig.secret).update(JSON.stringify({origin:gconfig.origin,target:gconfig.target,prefix:gconfig.prefix,challenge})).digest('hex');
          return response(200,JSON.stringify({...gconfig,secret:undefined,signature,challenge}));
        }
        return url.origin===gconfig.origin?response(variant==='temporary'?302:301,'redirect',target):response(200,'product page');
      };
      await runGateway(pool,id,target,variant,gatewayEnv,transport);
      const row=(await report(pool,id)).rows[0];assert.equal(row.run_state,'DISCOVERY_SIGNAL_OBSERVED');assert.equal(row.index_status,'UNKNOWN');assert.equal(row.first_verified_crawl_at,null);
    }
    const site=`https://owned.example/${randomUUID()}/`;
    const env={CMS_URL:site,CMS_AUTHORIZED:'true',CMS_USERNAME:'testuser',CMS_APPLICATION_PASSWORD:'synthetic-password'};
    const post=new URL('post',site).href;let posts=0;
    const wordpress:Transport=async(url,_signal,_read,options)=>{
      options?.onDispatch?.();
      if(url.pathname.endsWith('/users/me'))return response(200,JSON.stringify({capabilities:{publish_posts:true}}));
      if(options?.method==='POST'){posts++;assert.match(options.headers?.Authorization??'',/^Basic /);return response(201,JSON.stringify({id:12,status:'publish',link:post,secret:'do-not-store'}));}
      if(url.pathname.endsWith('/robots.txt'))return response(200,'User-agent: *\nAllow: /');
      if(url.pathname.endsWith('/feed/'))return response(200,`<rss><channel><item><description>${xmlEscape(`<a href="${target}">product</a>`)}</description></item></channel></rss>`);
      return response(200,`<a href="${target}">product</a>`);
    };
    const noConfirmation=await create('cms-publish','link');await runPublishing(pool,noConfirmation,target,'wordpress','link',undefined,false,env,never);assert.equal(calls,0);assert.equal((await report(pool,noConfirmation)).rows[0].run_state,'NOT_RUN');
    for(const variant of ['link','rss'] as const){
      const id=await create('cms-publish',variant);const plan=publicationPlan('wordpress',target,variant,env);
      await runPublishing(pool,id,target,'wordpress',variant,plan.confirmation_sha256,false,env,wordpress);
      const row=(await report(pool,id)).rows[0];assert.equal(row.run_state,'DISCOVERY_SIGNAL_OBSERVED');assert.equal(row.published_verified,true);assert.equal(row.index_status,'UNKNOWN');assert.equal(row.first_verified_crawl_at,null);
    }
    assert.equal(posts,1,'reuse receipt instead of publishing one post per variant');
    const privateCheck=await create('cms-publish','link');
    const privateTransport:Transport=async(url)=>url.pathname.endsWith('/robots.txt')?response(200,'User-agent: *\nDisallow: /'):response(200,`<meta name=robots content=noindex><a href="${target}">product</a>`);
    assert.equal((await verifyPublication(pool,privateCheck,post,target,privateTransport)).crawlable_reference,false);
    await pool.query("UPDATE publication_receipts SET status='UNKNOWN' WHERE provider='wordpress' AND site=$1",[site]);
    const pending=await create('cms-publish','link');
    await runPublishing(pool,pending,target,'wordpress','link',publicationPlan('wordpress',target,'link',env).confirmation_sha256,false,env,never);
    assert.equal((await report(pool,pending)).rows[0].run_state,'BLOCKED_CONFIGURATION');
    assert.equal(posts,1);
    const blogOrigin=`https://${randomUUID()}.blogspot.com`;
    const blogEnv={BLOGGER_AUTHORIZED:'true',BLOGGER_BLOG_ID:'1234567',BLOGGER_PUBLIC_ORIGIN:blogOrigin,BLOGGER_ACCESS_TOKEN:'synthetic-user-token'};
    const blogId=await create('blogger-publish','link');
    const blogger:Transport=async(url,_signal,_read,options)=>{
      options?.onDispatch?.();
      if(url.hostname==='www.googleapis.com')return options?.method==='POST'?response(200,JSON.stringify({id:'98765',url:blogOrigin+'/reference.html'})):response(200,JSON.stringify({id:'1234567',url:blogOrigin+'/'}));
      if(url.pathname==='/robots.txt')return response(200,'User-agent: *\nAllow: /');
      return response(200,`<a href="${target}">product</a>`);
    };
    await runPublishing(pool,blogId,target,'blogger','link',publicationPlan('blogger',target,'link',blogEnv).confirmation_sha256,false,blogEnv,blogger);
    assert.equal((await report(pool,blogId)).rows[0].run_state,'DISCOVERY_SIGNAL_OBSERVED');
    const rateName='mock-pagespeed-'+randomUUID();rateKeys.push(rateName);let psiCalls=0;
    const psi:Transport=async(_url,_signal,_read,options)=>{psiCalls++;options?.onDispatch?.();return response(429,JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'secret-api-key'}}));};
    const psiId=await create('pagespeed');await runPagespeed(pool,psiId,target,{},psi,async()=>({address:'8.8.8.8',family:4}),rateName);
    const psiRow=(await report(pool,psiId)).rows[0];assert.equal(psiRow.run_state,'REQUEST_SENT');assert.equal(psiRow.request_status,429);assert.equal(psiRow.output_metadata.classification,'DIAGNOSTIC_ONLY');assert.equal(psiRow.first_verified_crawl_at,null);assert.equal(psiRow.index_status,'UNKNOWN');
    const limited=await create('pagespeed');await runPagespeed(pool,limited,target,{},psi,async()=>({address:'8.8.8.8',family:4}),rateName);assert.equal(psiCalls,1);assert.equal((await report(pool,limited)).rows[0].run_state,'BLOCKED_CONFIGURATION');
    const successfulKey='mock-pagespeed-'+randomUUID();rateKeys.push(successfulKey);
    const rendered=await create('pagespeed');
    await runPagespeed(pool,rendered,target,{},async()=>response(200,JSON.stringify({lighthouseResult:{requestedUrl:target,finalUrl:target,fetchTime:new Date().toISOString(),categories:{performance:{score:0.9}}}})),async()=>({address:'8.8.8.8',family:4}),successfulKey);
    const renderedRow=(await report(pool,rendered)).rows[0];
    assert.equal(renderedRow.run_state,'REQUEST_SENT');assert.equal(renderedRow.output_metadata.diagnostic_render_returned,true);assert.equal(renderedRow.output_metadata.google_search_discovery_signal,false);assert.equal(renderedRow.first_verified_crawl_at,null);assert.equal(renderedRow.index_status,'UNKNOWN');
    const badProof=await create('redirect-gateway','temporary');let proofCalls=0;
    await runGateway(pool,badProof,target,'temporary',gatewayEnv,async()=>{proofCalls++;return response(200,JSON.stringify({signature:'wrong'}));});
    assert.equal(proofCalls,1);assert.equal((await report(pool,badProof)).rows[0].run_state,'REQUEST_SENT');
    const loopId=await create('redirect-gateway','temporary');
    await runGateway(pool,loopId,target,'temporary',gatewayEnv,async url=>{
      if(url.pathname==='/.well-known/url-indexer-lab'){
        const challenge=url.searchParams.get('challenge');const signature=createHmac('sha256',gconfig.secret).update(JSON.stringify({origin:gconfig.origin,target:gconfig.target,prefix:gconfig.prefix,challenge})).digest('hex');
        return response(200,JSON.stringify({...gconfig,secret:undefined,signature,challenge}));
      }
      return url.origin===gconfig.origin?response(302,'redirect',target):response(302,'loop',`${gconfig.origin}${gconfig.prefix}/temporary/${loopId}`);
    });
    assert.equal((await report(pool,loopId)).rows[0].run_state,'UNKNOWN');
    const allActions=await pool.query('SELECT * FROM experiment_actions WHERE experiment_id=ANY($1::uuid[])',[ids]);
    assert.doesNotMatch(JSON.stringify(allActions.rows),/synthetic-password|synthetic-user-token|synthetic-private|secret-api-key|do-not-store/);
  }finally{
    await pool.query('DELETE FROM observations WHERE experiment_id=ANY($1::uuid[])',[ids]);
    await pool.query('DELETE FROM experiments WHERE id=ANY($1::uuid[])',[ids]);
    await pool.query('DELETE FROM api_rate_limits WHERE name=ANY($1::text[])',[rateKeys]);
    await pool.end();
  }
});
