// Purpose: Exercise registered controller commands with mocked human UI and real phase containers.
import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir,homedir} from 'node:os';import cleanre from '../src/extension.ts';import {digest} from '../src/transfer.ts';import {podman} from '../src/backend.ts';
test('controller approval, phase mounts, stop and new-controller restart',{skip:!process.env.CLEANRE_TEST_IMAGE,timeout:120000},async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'cr-controller-'));const root=join(homedir(),'.local/state/pi-cleanre-workflow',digest(Buffer.from(cwd)));let handler:any,shutdown:any;const notices:string[]=[];let typed='';
 const load=()=>cleanre({registerCommand(_n:any,v:any){handler=v.handler;},on(_n:any,fn:any){shutdown=fn;}} as any);load();
 const model={id:'fake',name:'fake',provider:'test',api:'openai-completions',baseUrl:'https://invalid',reasoning:false,input:['text'],contextWindow:1000,maxTokens:100,cost:{input:1,output:1,cacheRead:0,cacheWrite:0}};
 const ctx={cwd,mode:'tui',hasUI:true,model,modelRegistry:{streamSimple(){throw Error('No cloud calls permitted');}},ui:{confirm:async()=>true,input:async()=>typed,notify:(s:string,kind:string)=>{notices.push(s);if(kind==='error')throw Error(s);}}};
 const command=async(s:string)=>{await handler(s,ctx);};
 try{
 await command('init');await command('configure '+process.env.CLEANRE_TEST_IMAGE+' 3');
 assert.equal(JSON.parse(await readFile(join(root,'cleanre-lock.json'),'utf8')).maxCost,3);
 for(const budget of ['0','-1','20','NaN','Infinity']) await assert.rejects(command('configure '+process.env.CLEANRE_TEST_IMAGE+' '+budget));
 const original=join(cwd,'original');await writeFile(original,'ORIGINAL-SENTINEL');await command('ingest '+original);
 const candidate=join(cwd,'candidate');await writeFile(candidate,JSON.stringify({schema:1,behavior:'APPROVED-SENTINEL',fixtures:[],provenance:['public']}));await command('export '+candidate);typed=notices.at(-1)!.split(' ')[1];await command('review '+typed);await command('verify '+typed);
 for(const phase of ['research','implementation']){
 await command('start '+phase);const record=JSON.parse(await readFile(join(root,'active.json'),'utf8'));const socket=JSON.parse(await readFile(join(root,'socket.json'),'utf8')).path;
 const input=await podman(['exec',record.name,'/bin/sh','-c','cat /input/*']);assert.equal(input.code,0);assert.match(input.stdout,phase==='research'?/ORIGINAL-SENTINEL/:/APPROVED-SENTINEL/);assert.doesNotMatch(input.stdout,phase==='research'?/APPROVED-SENTINEL/:/ORIGINAL-SENTINEL/);
 if(phase==='research'){await command('stop');}else{await shutdown();}
 await assert.rejects(readFile(join(socket,'worker.json')));load();
 }
 await command('verify '+typed);await command('stop');
 }finally{await shutdown();await rm(root,{recursive:true,force:true});await rm(cwd,{recursive:true,force:true});}
});
