// Purpose: Test actual image UID, read-only mounts, limits, and Unix socket access before launching Pi.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { chmod, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomic } from './state.ts';
import { Lifecycle } from './lifecycle.ts';
import { runPlan, podman, type Mounts, type Runner } from './backend.ts';
export async function probe(image: string, mounts: Mounts, runner: Runner = podman, journalRoot = dirname(mounts.state)) {
  const token=randomBytes(16).toString('hex'); const path=join(mounts.socket,'probe.sock');
  await writeFile(join(mounts.input,'probe-readonly'),token,{mode:0o400});
  const server=createServer(socket=>socket.end(token)); await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);}); await chmod(path,0o600);
  const script=`const fs=require('fs'),net=require('net'),os=require('os');
if(process.getuid()===0)throw Error('root');
if(Object.keys(os.networkInterfaces()).some(k=>k!=='lo'))throw Error('network');
if(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()!=='2147483648')throw Error('memory');
if(fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim()!=='256')throw Error('pids');
for(const p of ['/input/probe-readonly','/broker/probe.sock','/opt/cleanre/package.json']){let denied=false;try{fs.openSync(p,'w')}catch{denied=true}if(!denied)throw Error('writable protected mount')}
fs.writeFileSync('/workspace/probe','ok');fs.unlinkSync('/workspace/probe');
const s=net.connect('/broker/probe.sock');let value='';s.on('data',b=>value+=b);s.on('end',()=>{if(value!==${JSON.stringify(token)})process.exit(1)});s.on('error',()=>process.exit(1));`;
  const name=`cleanre-${randomBytes(16).toString('hex')}-research`;
  const args=runPlan(image,name,mounts).filter(x=>x!=='--detach'&&x!=='--interactive');
  args.splice(args.length-1,0,'--rm','--entrypoint=/usr/local/bin/node');args.push('-e',script);
  await atomic(join(journalRoot,'probe.json'),{name});
  try { const result=await runner(args); if(result.code)throw new Error('Real image isolation/socket probe failed'); }
  finally { await new Lifecycle(journalRoot,runner,'probe.json').close(); await new Promise<void>(resolve=>server.close(()=>resolve())); await unlink(path).catch(()=>{}); await unlink(join(mounts.input,'probe-readonly')); }
}
