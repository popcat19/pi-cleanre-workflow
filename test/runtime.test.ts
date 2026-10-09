// Purpose: Verify real rootless worker startup, broker inference, protected mounts, and cleanup with a fake provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { Model, Api, AssistantMessage } from '@earendil-works/pi-ai';
import { startBroker, catalog } from '../src/broker.ts';
import { Lifecycle } from '../src/lifecycle.ts';
import { probe } from '../src/probe.ts';
import { podman } from '../src/backend.ts';
import { resources, verifyImageResources } from '../src/lock.ts';
const model: Model<Api>={id:'fake',name:'fake',provider:'test',api:'openai-completions',baseUrl:'https://invalid',reasoning:false,input:['text'],contextWindow:1000,maxTokens:100,cost:{input:1,output:1,cacheRead:0,cacheWrite:0}};
test('real offline Pi worker reaches fake host broker and stops', {skip: !process.env.CLEANRE_TEST_IMAGE, timeout:90000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'cr-live-')); const mounts={state:join(root,'state'),workspace:join(root,'workspace'),input:join(root,'input'),socket:join(root,'socket')};
  for(const dir of Object.values(mounts))await mkdir(dir,{mode:0o700});
  const lifecycle=new Lifecycle(root); let calls=0;
  const broker=await startBroker(join(mounts.socket,'inference.sock'),{project:'test',phase:'research',model,maxRequests:2,maxTokens:100,maxCost:1},{streamSimple(_model,context){calls++; if(calls===2)assert.ok(context.messages.some(m=>m.role==='toolResult')); const stream=createAssistantMessageEventStream(); const message:AssistantMessage={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:0,stopReason:'stop',content:[{type:'text',text:'SYNTHETIC-OK'}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};if(calls===1){message.stopReason='toolUse';message.content=[{type:'toolCall',id:'read-one',name:'bash',arguments:{command:'printf TOOL-RESULT'}}];stream.push({type:'start',partial:{...message,stopReason:'pending'}});stream.push({type:'done',reason:'toolUse',message});stream.end();return stream;}stream.push({type:'start',partial:{...message,stopReason:'pending'}});stream.push({type:'text_start',contentIndex:0,partial:message});stream.push({type:'text_delta',contentIndex:0,delta:'SYNTHETIC-OK',partial:message});stream.push({type:'text_end',contentIndex:0,content:'SYNTHETIC-OK',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();return stream;}});
  try{
    await verifyImageResources(process.env.CLEANRE_TEST_IMAGE!,await resources());
    await probe(process.env.CLEANRE_TEST_IMAGE!,mounts);
    await writeFile(join(mounts.socket,'worker.json'),JSON.stringify({project:'test',phase:'research',model:catalog(model),capability:broker.capability}),{mode:0o400});
    const name=`cleanre-${randomBytes(16).toString('hex')}-research`;
    await lifecycle.start({image:process.env.CLEANRE_TEST_IMAGE!,name,mounts});
    const output=await new Promise<string>((resolve,reject)=>{const child=spawn('podman',['attach',name],{stdio:['pipe','pipe','pipe']});let text='';let prompted=true;child.stdin.write('Say synthetic ok\n');const timer=setTimeout(()=>{child.kill();reject(new Error('Attach timeout: '+text));},30000);child.stdout.on('data',b=>{text+=b;if(text.includes('cleanre>')&&!prompted){prompted=true;child.stdin.write('Say synthetic ok\n');}if(text.includes('SYNTHETIC-OK'))child.stdin.write('/quit\n');});child.stderr.on('data',b=>text+=b);child.on('error',reject);child.on('close',()=>{clearTimeout(timer);resolve(text);});});
    assert.match(output,/SYNTHETIC-OK/);assert.equal(calls,2);
    const inspected=await podman(['inspect',name]);assert.equal(JSON.parse(inspected.stdout)[0].HostConfig.NetworkMode,'none');
  }finally{await broker.close();await lifecycle.close();await rm(root,{recursive:true,force:true});}
});
test('SIGKILL during probe preserves ownership for restart cleanup',{skip:!process.env.CLEANRE_TEST_IMAGE,timeout:60000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'cr-probe-kill-'));const mounts={state:join(root,'state'),workspace:join(root,'workspace'),input:join(root,'input'),socket:join(root,'socket')};for(const p of Object.values(mounts))await mkdir(p,{mode:0o700});
 const script=`import {probe} from './src/probe.ts';import {podman} from './src/backend.ts';await probe(${JSON.stringify(process.env.CLEANRE_TEST_IMAGE)},${JSON.stringify(mounts)},async args=>{if(args[0]==='run'){const name=args[args.indexOf('--name')+1];const r=await podman(['run','--detach','--name',name,'--label','cleanre.owner='+name,'--network=none','--entrypoint=/usr/local/bin/node',${JSON.stringify(process.env.CLEANRE_TEST_IMAGE)},'-e','setInterval(()=>{},1000)']);if(r.code)throw Error('spawn');console.log('READY');await new Promise(()=>{});}return podman(args);});`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{stdio:['ignore','pipe','inherit']});
 try{await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);});child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('close',()=>resolve()));await new Lifecycle(root,undefined,'probe.json').close();const {json}=await import('../src/state.ts');assert.equal(await json(join(root,'probe.json')),null);}
 finally{child.kill('SIGKILL');await new Lifecycle(root,undefined,'probe.json').close();await rm(root,{recursive:true,force:true});}
});
