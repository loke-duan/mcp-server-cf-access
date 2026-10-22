import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { queryBody, previewBody, commitBody, registerBodyTools } from '../src/xunji-body.ts';
import { syncTemplates, previewTemplates, applyTemplates, registerTemplateTools } from '../src/xunji-templates.ts';
import { previewToken, verifyPreview } from '../src/xunji-api.ts';
const bodyEnv = { XUNJI_BODY_API_KEY: 'test-body-secret' };
const body = { client_request_id: 'body-1', records: [{ datestr: '2026-10-22', type: 'weist', value: 92 }] };
const value = r => JSON.parse(r.content[0].text);
const ok = res => Response.json({ success: true, res });
const state = { folder: { id: 'agent-folder', version: 1 }, template_versions: { old: 2 }, templates: [] };
const mutation = { mutation_id: 'mutation-1', upserts: [{ client_id: 'new-a', name: '腿 A', movements: [{ name: '深蹲', sets: [{ weight: 60, reps: 8, unit: 'kg' }] }] }], deletes: [] };
function templateEnv() {
 const cache = new Map();
 return { XUNJI_TEMPLATE_API_KEY: 'test-template-secret', OAUTH_KV: { get: async k => cache.get(k) ?? null, put: async (k,v,options) => { assert.equal(options.expirationTtl,86400); cache.set(k,v); } } };
}

test('body query preserves range, types and pagination, uses body key and gzip', async () => {
 const r = await queryBody(bodyEnv, { start_date: '2026-10-01', end_date: '2026-10-22', types: ['weist'], offset: 10 }, async (url, init) => {
  assert.equal(url, 'https://api.xunjiapp.cn/open/body/query_gzip');
  assert.equal(init.headers.Authorization, 'Bearer test-body-secret');
  assert.equal(init.redirect, 'manual');
  assert.deepEqual(JSON.parse(init.body), { start_date:'2026-10-01', end_date:'2026-10-22',types:['weist'],include_latest:true,include_records:true,limit:500,offset:10 });
  return new Response(gzipSync(JSON.stringify({success:true,res:{records:[],latest:{}}})));
 });
 assert.deepEqual(value(r).res.records, []);
});

test('body writes require matching dry-run, confirmation and exact reviewed records', async () => {
 const calls=[];
 const fetcher=async (_,init) => { const b=JSON.parse(init.body);calls.push(b);return ok(b.dry_run ? { summary: body.records } : { applied: body.records }); };
 const p=value(await previewBody(bodyEnv, body, fetcher));
 assert.equal(calls[0].dry_run,true);
 assert.equal(calls[0].confirmed,undefined);
 assert.ok(p.preview_token);
 const result=await commitBody(bodyEnv,{...body,preview_token:p.preview_token,confirmed:true},fetcher);
 assert.equal(result.isError,undefined);
 assert.equal(calls[1].dry_run,false);
 assert.equal(calls[1].confirmed,true);
 assert.equal(calls[1].client_request_id,body.client_request_id);
 const changed={...body,records:[{...body.records[0],value:93}],preview_token:p.preview_token,confirmed:true};
 assert.equal((await commitBody(bodyEnv,changed,fetcher)).isError,true);
 assert.equal((await commitBody(bodyEnv,{...body,preview_token:p.preview_token},fetcher)).isError,true);
 assert.equal(calls.length,2);
});

test('body invalid types, duplicate date/type, missing summary and reversed ranges are rejected',async()=>{
 const never=()=>assert.fail('must not fetch');
 assert.equal((await queryBody(bodyEnv,{start_date:'2026-10-22',end_date:'2026-10-01'},never)).isError,true);
 assert.equal((await previewBody(bodyEnv,{...body,records:[{...body.records[0],type:'waist'}]},never)).isError,true);
 assert.equal((await previewBody(bodyEnv,{...body,records:[...body.records,...body.records]},never)).isError,true);
 assert.equal((await previewBody(bodyEnv,body,async()=>ok({}))).isError,true);
});

test('preview signatures are expiring, payload-bound and domain-separated',async()=>{
 const token=await previewToken('body','key',body,1000);
 assert.equal(await verifyPreview(token,'body','key',body,2000),true);
 assert.equal(await verifyPreview(token,'body','other',body,2000),false);
 assert.equal(await verifyPreview(token,'templates','key',body,2000),false);
 assert.equal(await verifyPreview(token,'body','key',body,901001),false);
});

test('template sync preserves supplied cached versions and does not mutate',async()=>{
 const r=await syncTemplates(templateEnv(),{template_versions:{old:2}},async(url,init)=>{
  assert.equal(url,'https://trains.xunjiapp.cn/api_agent_templates_sync_for_llm_v2');
  assert.equal(init.headers.Authorization,'Bearer test-template-secret');
  assert.deepEqual(JSON.parse(init.body),{template_versions:{old:2}});
  return ok(state);
 });assert.deepEqual(value(r).res.template_versions,{old:2});
});

test('template preview syncs, then apply rechecks state and preserves confirmed mutation IDs',async()=>{
 const env=templateEnv();const urls=[];
 const fetcher=async(url,init)=>{urls.push(url);if(url.includes('_sync_'))return ok(state);const sent=JSON.parse(init.body);assert.equal(sent.mutation_id,'mutation-1');assert.equal(sent.confirmed,true);assert.equal(sent.upserts[0].client_id,'new-a');return ok({applied:[]});};
 const preview=value(await previewTemplates(env,mutation,fetcher));
 assert.equal(urls.length,1);assert.ok(urls[0].includes('_sync_'));
 const result=await applyTemplates(env,{mutation,preview_token:preview.preview_token,confirmed:true},fetcher);
 assert.equal(result.isError,undefined);assert.equal(urls.length,3);
 // Replayed ID is passed to the backend rather than being blocked by new versions.
 const replay=await applyTemplates(env,{mutation,preview_token:preview.preview_token,confirmed:true},fetcher);
 assert.equal(replay.isError,undefined);assert.equal(urls.length,4);assert.ok(urls[3].includes('_mutate_'));
});

test('template preview rejects out-of-folder IDs, conflicts, deleted folders and over-capacity',async()=>{
 const env=templateEnv();
 for(const [request,snapshot] of [
  [{...mutation,deletes:[{template_id:'outside',base_version:2}]},state],
  [{...mutation,deletes:[{template_id:'old',base_version:1}]},state],
  [mutation,{folder:null,folder_deleted:true,template_versions:{}}],
  [mutation,{...state,template_versions:Object.fromEntries(Array.from({length:14},(_,i)=>['t'+i,1]))}],
  [{...mutation,folder_update:{name:'改名',base_version:0}},state],
 ])assert.equal((await previewTemplates(env,request,async()=>ok(snapshot))).isError,true);
});

test('template limits, names and forbidden folder changes fail before any request',async()=>{
 const never=()=>assert.fail('must not fetch');const env=templateEnv();
 for(const request of [
  {...mutation,folder_id:'other'},
  {...mutation,folder_update:{name:'bad😀',base_version:1}},
  {...mutation,upserts:[{...mutation.upserts[0],movements:Array(16).fill(mutation.upserts[0].movements[0])}]},
  {...mutation,upserts:[{...mutation.upserts[0],movements:[{name:'深蹲',sets:Array(21).fill({reps:8})}]}]},
 ])assert.equal((await previewTemplates(env,request,never)).isError,true);
});

test('template apply rejects modified preview and stops on newly changed versions',async()=>{
 const env=templateEnv();const update={mutation_id:'u-1',upserts:[{...mutation.upserts[0],client_id:undefined,template_id:'old',base_version:2}],deletes:[]};
 const p=value(await previewTemplates(env,update,async()=>ok(state)));
 const changed={...update,upserts:[{...update.upserts[0],name:'改动'}]};
 assert.equal((await applyTemplates(env,{mutation:changed,preview_token:p.preview_token,confirmed:true},()=>assert.fail('must not fetch'))).isError,true);
 let calls=0;
 const result=await applyTemplates(env,{mutation:update,preview_token:p.preview_token,confirmed:true},async(url)=>{calls++;assert.ok(url.includes('_sync_'));return ok({...state,template_versions:{old:3}});});
 assert.equal(result.isError,true);assert.equal(calls,1);
});

test('all six registered tools require OAuth; only commit/apply are write tools',async()=>{
 const registered={};const server={registerTool:(n,c,fn)=>{registered[n]={c,fn};}};
 registerBodyTools(server,bodyEnv,false);registerTemplateTools(server,templateEnv(),false);
 assert.equal(Object.keys(registered).length,6);
 for(const [n,{c,fn}]of Object.entries(registered)){
  assert.equal(c.annotations.readOnlyHint,!['xunji_commit_body','xunji_apply_templates'].includes(n));
  assert.equal((await fn({})).isError,true);
 }
});
