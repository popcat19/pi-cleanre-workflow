// Purpose: Check write-ahead ownership, orphan cleanup, mount separation, and controller exclusion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lifecycle } from '../src/lifecycle.ts';
import { atomic, json, lease } from '../src/state.ts';
import { runPlan } from '../src/backend.ts';
const name='cleanre-'+ 'a'.repeat(32)+'-research';const image='sha256:'+'b'.repeat(64);const mounts={state:'/state',input:'/input',socket:'/socket',workspace:'/workspace'};
test('lifecycle journals intent before run and reconciles orphan by verified ID',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cr-state-'));let exists=false;let removed='';
 try { await mkdir(join(root,'state'));await writeFile(join(root,'state','ready'),'cleanre-ready-v1'); const lifecycle=new Lifecycle(root,async args=>{
 if(args[0]==='info')return{code:0,stdout:JSON.stringify({host:{security:{rootless:true},cgroupVersion:'v2',cgroupControllers:['memory','pids']}})};
 if(args[0]==='run'){assert.equal((await json(join(root,'active.json'))).name,name);exists=true;return{code:0,stdout:'c'.repeat(64)};}
 if(args[1]==='inspect')return exists?{code:0,stdout:JSON.stringify([{Id:'c'.repeat(64),State:{Running:true},Config:{Labels:{'cleanre.owner':name}}}])}:{code:1,stdout:''};
 if(args[0]==='rm'){removed=args.at(-1)!;exists=false;return{code:0,stdout:''};}return{code:1,stdout:''};});
 await lifecycle.start({image,name,mounts:{...mounts,state:join(root,'state')}});await lifecycle.close();await lifecycle.close();assert.equal(removed,'c'.repeat(64));assert.equal(await json(join(root,'active.json')),null);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('wrong container labels refuse cleanup and concurrent controller lease fails',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cr-state-'));
 try {const release=await lease(root);await assert.rejects(lease(root),/Another/);await release();
 await atomic(join(root,'active.json'),{name});const lifecycle=new Lifecycle(root,async()=>({code:0,stdout:JSON.stringify([{Id:'d'.repeat(64),Config:{Labels:{}}}])}));await assert.rejects(lifecycle.close(),/ownership/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('lease does not treat a bundled Pi executable as Node',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cr-bundled-'));
 const descriptor=Object.getOwnPropertyDescriptor(process,'execPath')!;
 try{
  Object.defineProperty(process,'execPath',{...descriptor,value:'/not-a-node-runtime'});
  const release=await lease(root);await release();
 }finally{Object.defineProperty(process,'execPath',descriptor);await rm(root,{recursive:true,force:true});}
});
test('writable mount aliases and ancestors are rejected; CPU quota is absent',()=>{
 assert.throws(()=>runPlan(image,name,{...mounts,state:'/socket'}),/Aliased/);
 assert.throws(()=>runPlan(image,name,{...mounts,state:'/socket/state'}),/Overlapping/);
 assert.equal(runPlan(image,name,mounts).some(arg=>arg.startsWith('--cpus')),false);
});
test('OS project lease releases after controller SIGKILL despite empty legacy file',async()=>{
 const {spawn}=await import('node:child_process');const {writeFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'cr-kill-'));
 try{
 await writeFile(join(root,'controller.lock'),'');
 const script=`import {lease} from './src/state.ts';await lease(${JSON.stringify(root)});console.log('READY');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{stdio:['ignore','pipe','inherit']});
 await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);});
 await assert.rejects(lease(root),/Another/);child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('close',()=>resolve()));
 let release: (()=>Promise<void>)|undefined;
 for(let i=0;i<20;i++){try{release=await lease(root);break;}catch{await new Promise(r=>setTimeout(r,25));}}
 assert.ok(release);await release();
 }finally{await rm(root,{recursive:true,force:true});}
});
