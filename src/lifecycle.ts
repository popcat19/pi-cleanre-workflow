// Purpose: Journal container intent before spawning and remove orphaned phase processes by verified identity.
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { atomic, json } from './state.ts';
import { containerName, imagePin, podman, prerequisites, runPlan, type Mounts, type Runner } from './backend.ts';
export interface StartPlan { image: string; name: string; mounts: Mounts; socketCleanup?: string }
export class Lifecycle {
  constructor(readonly root: string, private runner: Runner = podman, private journal = 'active.json') {}
  async close() {
    const path = join(this.root, this.journal); const record = await json(path); if (!record) return;
    containerName(record.name); const inspected = await this.runner(['container','inspect', record.name]);
    if (!inspected.code) {
      const actual = JSON.parse(inspected.stdout)[0];
      if (actual.Config?.Labels?.['cleanre.owner'] !== record.name || (record.id && actual.Id !== record.id)) throw new Error('Container ownership mismatch; refusing cleanup');
      const removed = await this.runner(['rm','--force', actual.Id]); if (removed.code) throw new Error('Container removal failed');
    } else {
      const exists = await this.runner(['container','exists',record.name]); if (exists.code !== 1) throw new Error('Cannot verify orphan absence');
    }
    if(record.socket){
      if(dirname(record.socket)!==join(homedir(),'.local/state')||!/^cr-[a-f0-9]{24}$/.test(basename(record.socket)))throw new Error('Invalid socket cleanup identity');
      await rm(record.socket,{recursive:true,force:true});
    }
    await atomic(path, null);
  }
  async start(plan: StartPlan) {
    await prerequisites(this.runner); imagePin(plan.image); containerName(plan.name);
    if (await json(join(this.root,'active.json'))) throw new Error('Reconcile prior container before starting');
    const args = runPlan(plan.image, plan.name, plan.mounts);
    await atomic(join(this.root,'active.json'), { name: plan.name, socket: plan.socketCleanup });
    try {
      const result = await this.runner(args); if (result.code || !/^[a-f0-9]{64}$/.test(result.stdout.trim())) throw new Error('Container startup failed');
      await atomic(join(this.root,'active.json'), { name: plan.name, id: result.stdout.trim(), socket: plan.socketCleanup });
      for(let attempt=0;attempt<100;attempt++){
        const inspected=await this.runner(['container','inspect',plan.name]);
        if(inspected.code||!JSON.parse(inspected.stdout)[0].State?.Running)throw new Error('Worker exited before readiness');
        try{if((await readFile(join(plan.mounts.state,'ready'),'utf8'))==='cleanre-ready-v1')return result.stdout.trim();}catch{}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new Error('Worker readiness timeout');
    } catch (error) { await this.close(); throw error; }
  }
}
