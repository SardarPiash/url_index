import { parseArgs } from 'node:util';
import { writeFile, open } from 'node:fs/promises';
import { database } from './db.js';
import { normalizeUrl } from './core.js';
import { authorizedUrl } from './http-diagnostic.js';
import { createExperiment, beginAction, endAction, finishExperiment } from './experiment-store.js';
import { blocked, liveOutcome } from './live-store.js';
import { gatewayConfig, createGatewayServer, runGateway } from './gateway.js';
import { runPublishing, type PublishVariant } from './publishing.js';
import { runPagespeed } from './pagespeed.js';
import { runDiscovery, type DiscoveryMethod } from './discovery.js';
import { runInspection } from './inspection.js';
import { parseLogs, importCrawls } from './crawl-monitor.js';
import { report, toCsv } from './report.js';
import { UserError } from './errors.js';
const commands=['gateway-serve','gateway-run','cms-publish','pagespeed','blogger-publish','experiment-suite','execution-report'];
export async function liveCli(argv:string[]):Promise<boolean>{
  if(!commands.includes(argv[0]??''))return false;
  const {positionals,values}=parseArgs({args:argv,allowPositionals:true,options:{'allowed-domain':{type:'string'},variant:{type:'string'},label:{type:'string'},port:{type:'string'},'confirm-publication':{type:'string'},preview:{type:'boolean'},csv:{type:'string'},markdown:{type:'string'}}});
  const [command,input,...extra]=positionals;
  const allowed:Record<string,string[]>={
    'gateway-serve':['port'],'gateway-run':['allowed-domain','variant','label'],
    'cms-publish':['allowed-domain','variant','label','confirm-publication','preview'],
    'blogger-publish':['allowed-domain','label','confirm-publication','preview'],
    pagespeed:['allowed-domain','label'],'experiment-suite':['allowed-domain','label'],
    'execution-report':['label','csv','markdown'],
  };
  if(extra.length||Object.keys(values).some(key=>!allowed[command!]!.includes(key)))throw new UserError('Unexpected arguments/options for live experiment command. Use --help.');
  if(command==='gateway-serve'){
    if(input)throw new UserError('gateway-serve uses environment configuration, not URL arguments.');
    const port=Number(values.port??8787);if(!Number.isInteger(port)||port<1||port>65535)throw new UserError('Invalid gateway port.');
    let config;try{config=gatewayConfig(process.env.GATEWAY_TARGET_URL??'');}catch{throw new UserError('Configure the authorized HTTPS gateway origin, fixed target and private proof secret first.');}
    const server=createGatewayServer(config);server.on('error',()=>{console.error('Gateway could not bind its local port.');process.exitCode=1;});
    server.listen(port,'127.0.0.1',()=>console.log(`Gateway listening on 127.0.0.1:${port}. Configured public origin: ${config.origin}. HTTPS reverse proxy/deployment is required; local serving is not public discovery evidence.`));
    return true;
  }
  if(command!=='execution-report'&&(!input||!values['allowed-domain']))throw new UserError('Provide one target URL and --allowed-domain HOST.');
  if(command==='execution-report'&&input)throw new UserError('execution-report accepts --label, --csv and --markdown only.');
  const target=input?normalizeUrl(input):'';
  if(input)authorizedUrl(target,values['allowed-domain']!);
  if(command==='gateway-run'&&!['temporary','permanent'].includes(values.variant??''))throw new UserError('gateway-run requires --variant temporary or permanent.');
  if(command==='cms-publish'&&!['link','rss','atom','sitemap'].includes(values.variant??'link'))throw new UserError('CMS variant must be link, rss, atom or sitemap.');
  if(values['confirm-publication']&&!/^[a-f0-9]{64}$/.test(values['confirm-publication']))throw new UserError('--confirm-publication requires the exact SHA-256 from --preview.');
  const pool=database();
  try{
    if(command==='execution-report'){
      const {rows}=await report(pool,undefined,values.label);
      console.table(rows.map(row=>({id:row.experiment_id,method:row.method,variant:row.variant,state:row.run_state,request:row.real_request_sent,http:row.request_status,published:row.published_verified,crawl:row.crawl_status,index:row.index_status})));
      if(values.csv)await writeFile(values.csv,toCsv(rows),{flag:'wx'});
      if(values.markdown){
        const cell=(value:unknown)=>String(value??'').replaceAll('|','\\|').replaceAll('\n',' ');
        const content=['# Actual experiment execution report','',`Generated: ${new Date().toISOString()}`,'','All states are observations; no causal speed comparison is supported for overlapping same-URL experiments.','', '| Experiment / timestamp | Method / variant | Final state | Real request / HTTP | Evidence / blocker / next step |','| --- | --- | --- | --- | --- |',...rows.map(row=>`| ${cell(row.experiment_id)} / ${cell(row.started_at.toISOString())} | ${cell(row.method)} / ${cell(row.variant)} | ${cell(row.run_state)} | ${row.real_request_sent} / ${cell(row.request_status)} | ${cell(row.output_metadata?.reason??row.action_history?.at(-1)?.details?.reason??row.limitations)} ${cell(row.output_metadata?.next_configuration_step??(['sitemap','internal-link','feed'].includes(row.method)?'Configure/publish a valid authorized source containing the target, then verify it.':''))} |`),'','Indexing confirmation requires separate reliable evidence; diagnostic rendering and public links do not prove Google discovery.',''].join('\n');
        await writeFile(values.markdown,content,{flag:'wx'});
      }
      return true;
    }
    const label=values.label??'live-discovery';
    const run=async(method:string,variant='default')=>{
      const id=await createExperiment(pool,method,target,label,variant);
      await pool.query("UPDATE observations SET run_state='NOT_RUN' WHERE experiment_id=$1",[id]);
      try{
      if(method==='redirect-gateway')await runGateway(pool,id,target,variant as 'temporary'|'permanent');
      else if(method==='cms-publish'||method==='blogger-publish')await runPublishing(pool,id,target,method==='cms-publish'?'wordpress':'blogger',variant as PublishVariant,values['confirm-publication'],values.preview);
      else if(method==='pagespeed')await runPagespeed(pool,id,target);
      else if(method==='baseline'){
        const action=await beginAction(pool,id,'BASELINE_NO_INTERVENTION');await endAction(pool,action,{request_sent:false,network_requests:0});
        await liveOutcome(pool,id,'UNKNOWN',{reason:'Baseline recorded without any intervention or network request.',next_configuration_step:'Collect subsequent trusted target server logs and authorized index-status evidence.'});
      }else if(['sitemap','internal-link','feed','redirect'].includes(method)){
        const source=method==='sitemap'?(process.env.DISCOVERY_SITEMAP_URL??new URL('/sitemap.xml',target).href):method==='internal-link'?(process.env.DISCOVERY_INTERNAL_LINK_URL??new URL('/',target).href):method==='feed'?(process.env.DISCOVERY_FEED_URL??new URL('/feed/',target).href):process.env.DISCOVERY_REDIRECT_URL;
        if(!source)await blocked(pool,id,'No authorized published redirect source endpoint is configured.','Set DISCOVERY_REDIRECT_URL on the target hostname, or configure and run the HTTPS gateway variants.');
        else{
          await pool.query('UPDATE observations SET run_state=NULL,discovery_url=$2 WHERE experiment_id=$1',[id,source]);
          await runDiscovery(pool,id,method as DiscoveryMethod,target,values['allowed-domain']!,source);
        }
      }else if(method==='url-inspection'){
        await pool.query('UPDATE observations SET run_state=NULL WHERE experiment_id=$1',[id]);await runInspection(pool,id,target);
        const result=(await pool.query('SELECT execution_status FROM experiments WHERE id=$1',[id])).rows[0];
        if(result.execution_status==='MANUAL_REQUIRED')await blocked(pool,id,'Authorized Search Console property/credentials are not configured.','Set SEARCH_CONSOLE_PROPERTY, SEARCH_CONSOLE_AUTHORIZED=true and secure GOOGLE_APPLICATION_CREDENTIALS.');
      }else if(method==='crawl-monitor'){
        if(!process.env.CRAWL_LOG_FILE)await blocked(pool,id,'No trusted own-server log file is configured.','Set CRAWL_LOG_FILE to validated JSONL from the actual origin/CDN; attach new evidence to the corresponding experiment.');
        else{
          const file=await open(process.env.CRAWL_LOG_FILE,'r');let entries;
          try{const stat=await file.stat();if(!stat.isFile()||stat.size>4*1024*1024)throw new Error('Invalid log file');entries=parseLogs(await file.readFile('utf8'));}finally{await file.close();}
          await importCrawls(pool,id,target,entries);await liveOutcome(pool,id,'UNKNOWN',{reason:'Trusted log import processed; see verified evidence events. Historical entries do not become new-experiment crawls.'});
        }
      }else if(method==='google-indexing-api'){
        const action=await beginAction(pool,id,'INDEXING_API_ELIGIBILITY_ASSESSMENT');await endAction(pool,action,{request_sent:false,page_type:'Product',reason:'Ordinary product URL is ineligible. No API notification sent.'});
        await liveOutcome(pool,id,'NOT_RUN',{reason:'Product URL is unsupported by the documented Google Indexing API.',next_configuration_step:'Use a genuine configured JobPosting or VideoObject/BroadcastEvent page for the separate existing guarded API adapter.'});
        await finishExperiment(pool,id,'UNSUPPORTED');
      }else await blocked(pool,id,method==='public-tool'?'Rich Results Test has no configured documented automation interface; it was not called.':'Request Indexing is a manual Search Console UI action, not the read-only Inspection API.','Use the supported PageSpeed diagnostic API, or perform a truthful authorized manual UI action via the existing workflow.');
      }catch{
        const sent=(await pool.query('SELECT real_request_sent FROM observations WHERE experiment_id=$1',[id])).rows[0]?.real_request_sent;
        await liveOutcome(pool,id,sent?'UNKNOWN':'BLOCKED_CONFIGURATION',{reason:'Adapter stopped because configuration, source/log input or transport validation failed. Sensitive details withheld.',next_configuration_step:'Review the configured endpoint/log file and recorded action statuses before retrying.'});
      }
      const row=(await report(pool,id)).rows[0];console.log(JSON.stringify({experiment_id:id,method,variant,run_state:row.run_state,real_request_sent:row.real_request_sent,http_status:row.request_status,...row.output_metadata}));
    };
    if(command==='experiment-suite'){
      await run('baseline');
      for(const variant of ['temporary','permanent'])await run('redirect-gateway',variant);
      for(const variant of ['link','rss','atom','sitemap'])await run('cms-publish',variant);
      await run('pagespeed');await run('blogger-publish','link');
      for(const method of ['sitemap','internal-link','feed','redirect','public-tool','google-indexing-api','url-inspection','request-indexing','crawl-monitor'])await run(method);
    }else await run(command==='gateway-run'?'redirect-gateway':command!,command==='cms-publish'?(values.variant??'link'):command==='blogger-publish'?'link':values.variant??'default');
    return true;
  }finally{await pool.end();}
}
