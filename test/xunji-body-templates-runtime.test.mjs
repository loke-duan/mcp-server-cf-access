import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('body preview/commit and template preview/apply run inside Workers with synthetic APIs',async()=>{
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
  import { queryBody, previewBody, commitBody } from './src/xunji-body.ts';
  import { syncTemplates, previewTemplates, applyTemplates } from './src/xunji-templates.ts';
  const cache=new Map();
  const env={XUNJI_BODY_API_KEY:'runtime-body',XUNJI_TEMPLATE_API_KEY:'runtime-template',OAUTH_KV:{get:async k=>cache.get(k)??null,put:async(k,v)=>cache.set(k,v)}};
  const value=r=>JSON.parse(r.content[0].text);
  export default {async fetch(){
   const query=await queryBody(env,{start_date:'2026-10-22',end_date:'2026-10-22'});
   const body={client_request_id:'test-body',records:[{datestr:'2026-10-22',type:'weight',value:80}]};
   const bp=await previewBody(env,body); if(bp.isError)return Response.json(bp);
   const bc=await commitBody(env,{...body,preview_token:value(bp).preview_token,confirmed:true});
   const sync=await syncTemplates(env,{});
   const mutation={mutation_id:'test-template',folder_update:{name:'训练模板',base_version:1},upserts:[],deletes:[]};
   const tp=await previewTemplates(env,mutation); if(tp.isError)return Response.json(tp);
   const tc=await applyTemplates(env,{mutation,preview_token:value(tp).preview_token,confirmed:true});
   return Response.json({query,bp,bc,sync,tp,tc});
  }};
 `},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:zlib']});
 const calls=[];
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-03-10',compatibilityFlags:['nodejs_compat'],outboundService:async req=>{
  const body=await req.json();calls.push({url:req.url,body});
  if(req.url.includes('/open/body/')){
   assert.equal(req.headers.get('Authorization'),'Bearer runtime-body');
   return Response.json({success:true,res:req.url.includes('query')?{records:[]}:{summary:body.records}});
  }
  assert.equal(req.headers.get('Authorization'),'Bearer runtime-template');
  if(req.url.includes('_sync_'))return Response.json({res:{folder:{id:'agent',version:1},template_versions:{},templates:[]}});
  assert.equal(body.confirmed,true);return Response.json({res:{applied:[]}});
 }}));
 try{
  const result=await(await mf.dispatchFetch('https://runtime.invalid')).json();
  assert.equal(result.isError,undefined,JSON.stringify(result));
  for(const [key,resultItem]of Object.entries(result))assert.equal(resultItem.isError,undefined,key+JSON.stringify(resultItem));
  assert.equal(calls.length,7);
  const writes=calls.filter(c=>c.url.includes('upsert')||c.url.includes('_mutate_'));
  assert.equal(writes.length,3);assert.equal(writes[0].body.dry_run,true);assert.equal(writes[1].body.confirmed,true);assert.equal(writes[2].body.confirmed,true);
 }finally{await mf.dispose();}
});
