// Purpose: Check broker capability binding, event forwarding, budgets and adapter cancellation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { Api, Model, AssistantMessage } from '@earendil-works/pi-ai';
import { startBroker, catalog } from '../src/broker.ts';
import { brokerStream } from '../src/adapter.ts';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
const model: Model<Api> = { id: 'safe', name: 'Safe', provider: 'test', api: 'openai-completions', baseUrl: 'https://secret.invalid', headers: { authorization: 'secret' }, reasoning: false, input: ['text'], contextWindow: 1000, maxTokens: 100, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: '✓' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.000001, output: 0.000001, cacheRead: 0, cacheWrite: 0, total: 0.000002 } } };
function post(path: string, capability: string, body: unknown) { return new Promise<number>((resolve, reject) => { const req = request({ socketPath: path, path: '/infer', method: 'POST', headers: { authorization: `Bearer ${capability}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }); req.on('error', reject); req.end(JSON.stringify(body)); }); }
test('broker binds phase, project, model and capability and enforces request cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cr-')); const path = join(root, 's'); let calls = 0;
  const broker = await startBroker(path, { project: 'p', phase: 'research', model, maxRequests: 1, maxTokens: 10, maxCost: 1 }, { streamSimple() { calls++; const s = createAssistantMessageEventStream(); s.push({ type: 'start', partial: { ...message, stopReason: 'pending' } }); s.push({ type: 'done', reason: 'stop', message }); s.end(); return s; } });
  try {
    const body = { project: 'p', phase: 'research', model: 'safe', context: { messages: [] } };
    for (const invalid of ['wrong', 'é'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(65)]) {
      assert.equal(await post(path, invalid, body), 403);
    }
    assert.equal(calls, 0);
    for (const change of [{ phase: 'implementation' }, { project: 'other' }, { model: 'unapproved' }, { headers: {} }]) assert.equal(await post(path, broker.capability, { ...body, ...change }), 400);
    let payload = false, response = false;
    const stream = brokerStream(path, broker.capability, 'p', 'research', model, normalizeContext({ messages: [] }), { onPayload() { payload = true; }, onResponse() { response = true; } });
    const result = await stream.result(); assert.equal(result.content[0].type, 'text'); assert.equal(result.usage.totalTokens, 2); assert.ok(payload && response);
    assert.equal(await post(path, broker.capability, body), 429); assert.equal(calls, 1);
    assert.equal(JSON.stringify(catalog(model)).includes('secret'), false);
  } finally { await broker.close(); await broker.close(); await rm(root, { recursive: true, force: true }); }
});
test('adapter reports aborted and unavailable transport without leaking errors', async () => {
  const abort = new AbortController(); abort.abort();
  const result = await brokerStream('/not-present', 'x', 'p', 'research', model, normalizeContext({ messages: [] }), { signal: abort.signal }).result();
  assert.equal(result.stopReason, 'aborted');
  const missing = await brokerStream('/not-present', 'x', 'p', 'research', model, normalizeContext({ messages: [] })).result(); assert.equal(missing.stopReason, 'error');
});
test('missing terminal stream fails closed and broker shutdown is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cr-')); const path = join(root, 's');
  const broker = await startBroker(path, { project: 'p', phase: 'research', model, maxRequests: 2, maxTokens: 10, maxCost: 1 }, { streamSimple() { const s = createAssistantMessageEventStream(); s.push({ type: 'start', partial: { ...message, stopReason: 'pending' } }); s.end(message); return s; } });
  try {
    const result = await brokerStream(path, broker.capability, 'p', 'research', model, normalizeContext({ messages: [] })).result();
    assert.equal(result.stopReason, 'error');
  } finally { await broker.close(); await broker.close(); await rm(root, { recursive: true, force: true }); }
});
test('broker enforces concurrency and conservative budget',async()=>{const root=await mkdtemp(join(tmpdir(),'cr-')),path=join(root,'s');let release!:()=>void;const broker=await startBroker(path,{project:'p',phase:'research',model,maxRequests:5,maxTokens:10,maxCost:.0015},{streamSimple(_m,_c,opts){const s=createAssistantMessageEventStream();new Promise<void>(r=>release=r).then(()=>{s.push({type:'start',partial:{...message,stopReason:'pending'}});s.push({type:'done',reason:'stop',message});s.end();});opts?.signal?.addEventListener('abort',()=>s.end(),{once:true});return s;}});try{const body={project:'p',phase:'research',model:'safe',context:{messages:[]}};const first=brokerStream(path,broker.capability,'p','research',model,normalizeContext(body.context));await new Promise(r=>setTimeout(r,100));assert.equal(await post(path,broker.capability,body),429);release();await first.result();assert.equal(await post(path,broker.capability,body),429);}finally{release?.();await broker.close();await rm(root,{recursive:true,force:true});}});
test('active adapter cancellation aborts host stream',async()=>{const root=await mkdtemp(join(tmpdir(),'cr-')),path=join(root,'s');let aborted=false;const broker=await startBroker(path,{project:'p',phase:'research',model,maxRequests:2,maxTokens:10,maxCost:1},{streamSimple(_m,_c,opts){const s=createAssistantMessageEventStream();opts?.signal?.addEventListener('abort',()=>{aborted=true;s.end();},{once:true});return s;}});try{const ac=new AbortController();const result=brokerStream(path,broker.capability,'p','research',model,normalizeContext({messages:[]}),{signal:ac.signal});setTimeout(()=>ac.abort(),100);assert.equal((await result.result()).stopReason,'aborted');await new Promise(r=>setTimeout(r,50));assert.equal(aborted,true);}finally{await broker.close();await rm(root,{recursive:true,force:true});}});
