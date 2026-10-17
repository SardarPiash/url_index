import { createHash } from 'node:crypto';
import robotsModule from 'robots-parser';
const robotsParser=robotsModule as unknown as (url:string,body:string)=>{isAllowed:(url:string,ua:string)=>boolean|undefined};
import type pg from 'pg';
import { xmlEscape, artifact, discoveryEvidence, htmlRobotsDirectives } from './discovery.js';
import { normalizeUrl } from './core.js';
import { publicRequest } from './http-diagnostic.js';
import { blocked, httpsUrl, liveOutcome, objectJson, requestAction, type Transport } from './live-store.js';
export type Publisher='wordpress'|'blogger';
export type PublishVariant='link'|'rss'|'atom'|'sitemap';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function publicationPlan(provider:Publisher,target:string,variant:PublishVariant,env:NodeJS.ProcessEnv=process.env){
  const beauty=new URL(target).hostname==='beautyhallbd.com';
  const title=beauty?'BeautyHall ceramide face mask — discovery experiment reference':'Authorized URL discovery experiment reference';
  const html=`<p>This transparent, authorized experiment records a published reference to an existing product page. It is not a product review or a promise of Google crawling or indexing.</p><p><a href="${xmlEscape(target)}">${beauty?'BeautyHall ceramide face mask 30ml product page':'Referenced page'}</a></p><p>The experiment compares observable URL discovery signals; verified crawler logs and separate Search Console evidence are required before drawing conclusions.</p>`;
  const contentHash=digest({title,html,target});
  const site=provider==='wordpress'?env.CMS_URL:env.BLOGGER_PUBLIC_ORIGIN;
  let safeSite='UNCONFIGURED';
  try{const url=httpsUrl(site??'');url.search='';safeSite=url.href;}catch{if(site)safeSite='INVALID_CONFIGURATION';}
  const approvalHash=digest({provider,site:safeSite,blog_id:provider==='blogger'&&/^\d{1,30}$/.test(env.BLOGGER_BLOG_ID??'')?env.BLOGGER_BLOG_ID:undefined,target,variant,contentHash});
  return {title,html,content_sha256:contentHash,confirmation_sha256:approvalHash,provider,site:safeSite,variant};
}
export function generatedResource(variant:PublishVariant,target:string,post:string){
  if(variant==='atom')return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>${xmlEscape(post)}</id><title>Authorized product discovery experiment</title><updated>${new Date().toISOString()}</updated><entry><id>${xmlEscape(post)}</id><title>BeautyHall product reference</title><updated>${new Date().toISOString()}</updated><link href="${xmlEscape(target)}"/></entry></feed>`;
  return artifact(variant==='sitemap'?'sitemap':variant==='rss'?'feed':'internal-link',variant==='sitemap'?post:target).text;
}
function publishedUrl(input:unknown,origin:string){
  if(typeof input!=='string')throw new Error('No resource URL');
  const candidate=new URL(input);
  if(candidate.protocol==='http:'&&candidate.hostname===new URL(origin).hostname&&!candidate.port&&!candidate.username&&!candidate.password)candidate.protocol='https:';
  const url=httpsUrl(candidate.href);
  if(url.origin!==origin||(url.search&&!/^\?p=\d+$/.test(url.search)))throw new Error('Out of scope public URL');
  return url.href;
}
export async function verifyPublication(pool:pg.Pool,id:string,resource:string,target:string,transport:Transport=publicRequest){
  const response=await requestAction(pool,id,'VERIFY_PUBLIC_POST',httpsUrl(resource),{},transport);
  const found=response.status===200&&discoveryEvidence('internal-link',response.body??'',resource,target).found;
  const robotsUrl=new URL('/robots.txt',resource);
  const robots=await requestAction(pool,id,'VERIFY_PUBLIC_ROBOTS',robotsUrl,{},transport);
  const allowed=robots.status===404||(robots.status===200&&robotsParser(robotsUrl.href,robots.body??'').isAllowed(resource,'Googlebot')===true);
  const headerAllows=!/\b(?:nofollow|none|noindex)\b/i.test(response.robots_tag??'');
  const noindexMeta=htmlRobotsDirectives(response.body??'').some(value=>['noindex','none'].includes(value));
  return {public_http_status:response.status,target_link_present:found,robots_http_status:robots.status,robots_allowed:allowed,crawlable_reference:found&&allowed&&headerAllows&&!noindexMeta};
}
export async function runPublishing(pool:pg.Pool,id:string,target:string,provider:Publisher,variant:PublishVariant,confirmation?:string,preview=false,env:NodeJS.ProcessEnv=process.env,transport:Transport=publicRequest){
  const plan=publicationPlan(provider,target,variant,env);
  if(preview){await liveOutcome(pool,id,'NOT_RUN',{publication_preview:plan,next_configuration_step:'Review this exact content/site, configure authorization/credentials, then pass --confirm-publication with confirmation_sha256.'});return;}
  let origin:string;
  let endpoint:URL;
  let headers:Record<string,string>;
  try{
    if(provider==='wordpress'){
      if(env.CMS_AUTHORIZED!=='true'||!env.CMS_URL||!env.CMS_USERNAME||!env.CMS_APPLICATION_PASSWORD)throw new Error('Missing CMS configuration');
      const base=httpsUrl(env.CMS_URL);
      if(base.search||!base.pathname.endsWith('/')||env.CMS_USERNAME.includes(':'))throw new Error('Invalid CMS configuration');
      origin=base.origin;endpoint=new URL('wp-json/wp/v2/posts',base);
      headers={Authorization:'Basic '+Buffer.from(`${env.CMS_USERNAME}:${env.CMS_APPLICATION_PASSWORD}`).toString('base64'),'Content-Type':'application/json'};
    }else{
      if(env.BLOGGER_AUTHORIZED!=='true'||!env.BLOGGER_PUBLIC_ORIGIN||!/^\d+$/.test(env.BLOGGER_BLOG_ID??'')||!env.BLOGGER_ACCESS_TOKEN||/[\r\n]/.test(env.BLOGGER_ACCESS_TOKEN))throw new Error('Missing Blogger configuration');
      const base=httpsUrl(env.BLOGGER_PUBLIC_ORIGIN);if(base.pathname!=='/'||base.search)throw new Error('Invalid Blogger origin');
      origin=base.origin;endpoint=new URL(`https://www.googleapis.com/blogger/v3/blogs/${env.BLOGGER_BLOG_ID}/posts?isDraft=false`);
      headers={Authorization:`Bearer ${env.BLOGGER_ACCESS_TOKEN}`,'Content-Type':'application/json'};
    }
  }catch{await blocked(pool,id,`Authorized ${provider} publishing credentials/site are missing or invalid.`,provider==='wordpress'?'Configure CMS_URL (trailing slash), CMS_AUTHORIZED=true, CMS_USERNAME and CMS_APPLICATION_PASSWORD.':'Configure BLOGGER_BLOG_ID, BLOGGER_PUBLIC_ORIGIN, BLOGGER_AUTHORIZED=true and a user OAuth BLOGGER_ACCESS_TOKEN with Blogger scope.');return;}
  if(confirmation!==plan.confirmation_sha256){await liveOutcome(pool,id,'NOT_RUN',{publication_preview:plan,reason:'Explicit confirmation of this exact site/content/variant is required.',next_configuration_step:'Review --preview output; rerun with --confirm-publication CONFIRMATION_SHA256.'});return;}
  const site=provider==='wordpress'?endpoint.origin+endpoint.pathname.replace(/wp-json\/wp\/v2\/posts$/,''):env.BLOGGER_BLOG_ID!;
  let resource:string|undefined;
  let reserved=false;
  try{
    const existing=await pool.query('SELECT * FROM publication_receipts WHERE provider=$1 AND site=$2 AND target_url=$3',[provider,site,target]);
    if(existing.rows[0]){
      const receipt=existing.rows[0];
      if(receipt.status!=='PUBLISHED'||receipt.content_sha256!==plan.content_sha256){await blocked(pool,id,'Previous publication is pending/uncertain or content differs; duplicate publication was prevented.','Inspect the earlier experiment and reconcile its public resource before any retry.');return;}
      resource=publishedUrl(receipt.resource_url,origin);
    }else{
      if(provider==='wordpress'){
        const capabilityUrl=new URL(endpoint.href);capabilityUrl.pathname=capabilityUrl.pathname.replace(/posts$/,'users/me');capabilityUrl.search='context=edit&_fields=id,capabilities';
        const preflight=await requestAction(pool,id,'WORDPRESS_AUTHORIZATION_PREFLIGHT',capabilityUrl,{headers},transport);
        if(preflight.status!==200||objectJson(preflight.body).capabilities?.publish_posts!==true){await liveOutcome(pool,id,'REQUEST_SENT',{reason:'WordPress did not confirm publish_posts capability; no post created.',next_configuration_step:'Grant the configured account permission to publish posts; check API status.'});return;}
      }else{
        const preflight=await requestAction(pool,id,'BLOGGER_AUTHORIZATION_PREFLIGHT',new URL(`https://www.googleapis.com/blogger/v3/blogs/${env.BLOGGER_BLOG_ID}`),{headers},transport);
        const blog=objectJson(preflight.body);
        if(preflight.status!==200||String(blog.id)!==env.BLOGGER_BLOG_ID||typeof blog.url!=='string'||new URL(blog.url).hostname!==new URL(origin).hostname){await liveOutcome(pool,id,'REQUEST_SENT',{reason:'Blogger blog/account preflight failed; no post created.',next_configuration_step:'Verify blog ID, public origin and user OAuth authorization.'});return;}
      }
      const reservation=await pool.query(`INSERT INTO publication_receipts(provider,site,target_url,experiment_id,content_sha256,status) VALUES($1,$2,$3,$4,$5,'PENDING') ON CONFLICT DO NOTHING RETURNING provider`,[provider,site,target,id,plan.content_sha256]);
      if(!reservation.rowCount){await blocked(pool,id,'Another publication attempt already reserved this site/target.','Inspect the existing publication receipt; do not duplicate the post.');return;}
      reserved=true;
      const payload=provider==='wordpress'?{title:plan.title,content:plan.html,status:'publish',comment_status:'closed',ping_status:'closed'}:{kind:'blogger#post',title:plan.title,content:plan.html};
      const response=await requestAction(pool,id,'PUBLISH_ONE_TRANSPARENT_POST',endpoint,{method:'POST',headers,body:JSON.stringify(payload)},transport);
      const data=objectJson(response.body);
      if(![200,201].includes(response.status)||(provider==='wordpress'&&data.status!=='publish')||!/^\d{1,30}$/.test(String(data.id??'')))throw new Error('Publication not accepted');
      resource=publishedUrl(provider==='wordpress'?data.link:data.url,origin);
      await pool.query("UPDATE publication_receipts SET status='PUBLISHED',resource_id=$4,resource_url=$5 WHERE provider=$1 AND site=$2 AND target_url=$3",[provider,site,target,String(data.id),resource]);
    }
    const verification=await verifyPublication(pool,id,resource,target,transport);
    let variantVerified=verification.crawlable_reference;
    let discovery=resource;
    let generated:string|undefined;
    if(variant!=='link'){
      const base=provider==='wordpress'?env.CMS_URL!:origin+'/';
      const configured=variant==='rss'?env.CMS_FEED_URL:variant==='atom'?env.CMS_ATOM_URL:env.CMS_SITEMAP_URL;
      const path=provider==='wordpress'?(variant==='rss'?'feed/':variant==='atom'?'feed/atom/':'wp-sitemap-posts-post-1.xml'):(variant==='rss'?'feeds/posts/default?alt=rss':variant==='atom'?'feeds/posts/default':'sitemap.xml');
      const url=httpsUrl(configured??new URL(path,base).href);if(url.origin!==origin)throw new Error('Feed/sitemap outside authorized origin');
      const result=await requestAction(pool,id,'VERIFY_PUBLISHED_FEED_OR_SITEMAP',url,{},transport);
      let member=false;
      if(result.status===200)member=discoveryEvidence(variant==='sitemap'?'sitemap':'feed',result.body??'',url.href,variant==='sitemap'?resource:target).found;
      variantVerified=variantVerified&&member;
      discovery=url.href;
      generated=generatedResource(variant,target,resource);
    }
    await liveOutcome(pool,id,variantVerified?'DISCOVERY_SIGNAL_OBSERVED':'REQUEST_SENT',{provider,variant,content_sha256:plan.content_sha256,public_post_url:resource,publication_verified:verification,variant_verified:variantVerified,generated_resource:generated,generated_resource_is_local_only:!!generated,reason:variantVerified?'A public crawlable reference was observed by this application; Google discovery is unverified.':'Publication response recorded, but public crawlability or requested feed/sitemap membership was not fully verified.',next_configuration_step:variantVerified?'Collect trusted crawler logs and authorized Search Console evidence.':'Check public visibility, robots rules and configured feed/sitemap endpoint.'},discovery,verification.crawlable_reference);
  }catch{
    if(reserved)await pool.query("UPDATE publication_receipts SET status=CASE WHEN resource_url IS NULL THEN 'UNKNOWN' ELSE status END WHERE provider=$1 AND site=$2 AND target_url=$3",[provider,site,target]);
    await liveOutcome(pool,id,'UNKNOWN',{provider,variant,public_post_url:resource,reason:'Publishing/verification failed or delivery is uncertain. No automatic retry or duplicate post was attempted.',next_configuration_step:'Inspect action status and reconcile the publication receipt before retrying.'},resource);
  }
}
