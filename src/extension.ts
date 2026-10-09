// Purpose: Own human-authorized phase launches, immutable transfers, and isolated worker lifecycle.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mkdir, realpath, readFile, writeFile, readdir, lstat, rm } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { digest, Transfers, readRegular } from './transfer.ts';
import { doctor, phase, prerequisites } from './backend.ts';
import { Lifecycle } from './lifecycle.ts';
import { startBroker, catalog } from './broker.ts';
import { atomic, json, lease } from './state.ts';
import { resources, inspectImage, verifyImageResources } from './lock.ts';
import { probe } from './probe.ts';
import { attachWorker } from './worker-console.ts';
import { reviewCandidate, selectCandidate } from './review-screen.ts';

export default function cleanre(pi: ExtensionAPI) {
  let active: { root: string; lifecycle: Lifecycle; release: () => Promise<void>; socket?: string; broker?: Awaited<ReturnType<typeof startBroker>> } | undefined;
  let busy = false;
  let workerName: string | undefined;
  let researchExport: string | undefined;
  async function openWorker(ui: Parameters<typeof attachWorker>[1]) {
    if (!workerName) throw new Error('No active worker');
    const result = await attachWorker(workerName, ui);
    if (result === 'stop' && await ui.confirm('Stop owned worker?', 'This ends the worker and broker. Esc from the panel only detaches.')) await close();
    if (result === 'failed') ui.notify('Worker attach failed; /cleanre stop cleans up the owned worker.', 'error');
  }
  async function cleanupSocket(root:string){
    const record=await json(join(root,'socket.json'));if(!record)return;
    if(dirname(record.path)!==join(homedir(),'.local/state')||!/^cr-[a-f0-9]{24}$/.test(basename(record.path)))throw new Error('Invalid socket identity');
    await rm(record.path,{recursive:true,force:true});await atomic(join(root,'socket.json'),null);
  }
  async function close() {
    if (!active) return;
    await active.broker?.close(); active.broker = undefined;
    await active.lifecycle.close(); if (active.socket) await rm(active.socket,{recursive:true,force:true}); await cleanupSocket(active.root); await active.release(); active = undefined; workerName = undefined; researchExport = undefined;
  }
  pi.registerCommand('cleanre', {
    description: 'init, doctor, configure IMAGE [RESERVATION_USD], ingest PATH, start PHASE, attach, export [PATH], review [HASH], verify HASH, stop',
    handler: async (args, ctx) => {
      if (busy) { ctx.ui.notify('Cleanre operation active','warning'); return; } busy = true;
      try {
        const [command,...rest] = args.trim().split(/\s+/); const value = rest.join(' ');
        if (command === 'doctor') { ctx.ui.notify((await doctor()).join('\n'),'info'); return; }
        if (ctx.mode !== 'tui' || !ctx.hasUI) throw new Error('Cleanre authority commands require direct TUI interaction');
        const project = digest(Buffer.from(await realpath(ctx.cwd)));
        const root = join(homedir(), '.local/state/pi-cleanre-workflow',project);
        if (active && active.root !== root) throw new Error('Stop the active project before switching projects');
        if (!active) {
          const release = await lease(root); const lifecycle = new Lifecycle(root);
          active = { root, release, lifecycle };
          try { await new Lifecycle(root,undefined,'probe.json').close(); await lifecycle.close(); await cleanupSocket(root); } catch (error) { await release(); active=undefined; throw error; }
        }
        const stat = await lstat(root); if (stat.isSymbolicLink() || !stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw new Error('Unsafe controller directory');
        if (command === 'stop') { await close(); ctx.ui.notify('Owned workers and broker stopped','info'); return; }
        if (command === 'attach') {
          await openWorker(ctx.ui);
          return;
        }
        const transfers = new Transfers(root);
        if (command === 'init') {
          if (await json(join(root,'policy.json'))) throw new Error('Project already initialized');
          if (!await ctx.ui.confirm('Initialize project?', 'Cloud inference discloses prompts to the provider. Containers do not establish legal clean-room status.')) return;
          await transfers.init(); await mkdir(join(root,'originals'),{ mode:0o700 });
          await atomic(join(root,'policy.json'), { schema: 1, project, pi: '0.87.1', adapter: '0.1.0', cpu: 'optional-unlimited' });
          ctx.ui.notify('Initialized project policy','info'); return;
        }
        const policy = await json(join(root,'policy.json')); if (policy?.schema !== 1 || policy.project !== project || policy.pi !== '0.87.1') throw new Error('Initialize a compatible project first');
        if (command === 'configure') {
          if (active.broker) throw new Error('Stop active worker before configuring');
          if (!ctx.model) throw new Error('Select a host model first');
          if (rest.length < 1 || rest.length > 2) throw new Error('Expected image and optional reservation');
          const maxCost = rest.length === 2 ? Number(rest[1]) : 1;
          if (!Number.isFinite(maxCost) || maxCost <= 0 || maxCost >= 20) throw new Error('Reservation must be positive and below $20');
          await prerequisites(); const image = await inspectImage(rest[0]);
          const lock = { maxCost, schema:1, pi:'0.87.1', adapter:'0.1.0', image, resources:await resources(), provider:ctx.model.provider, model:catalog(ctx.model) };
          await verifyImageResources(image.id,lock.resources);
          if (!await ctx.ui.confirm('Approve image and cloud model?', `${image.id}\n${lock.provider}/${lock.model.id}\nPer worker: at most 100 requests, 4096 output tokens/request, $${maxCost} cumulative catalog reservation (not actual spend). CPU quota is not enforced.`)) return;
          await atomic(join(root,'cleanre-lock.json'),lock); ctx.ui.notify('Image, resources and model pinned','info'); return;
        }
        if (command === 'ingest') {
          if (!await ctx.ui.confirm('Research-only original input?', 'Confirm the file is legally supplied. It will be copied only to research-owned input storage.')) return;
          const bytes = await readRegular(value, 64*1024*1024); const hash = digest(bytes);
          await writeFile(join(root,'originals',hash),bytes,{flag:'wx',mode:0o400}); ctx.ui.notify(`Original captured ${hash}`,'info'); return;
        }
        if (command === 'start') {
          if (active.broker) throw new Error('One active phase per controller; stop it first');
          const workerPhase = phase(value); const lock = await json(join(root,'cleanre-lock.json'));
          if (!lock || JSON.stringify(lock.resources) !== JSON.stringify(await resources())) throw new Error('Worker resources changed; rebuild and configure reviewed image');
          if (!ctx.model || ctx.model.provider !== lock.provider || ctx.model.id !== lock.model.id) throw new Error('Select the approved provider/model');
          await prerequisites(); const image = await inspectImage(lock.image.id); if (image.id !== lock.image.id) throw new Error('Image mismatch');
          if (!await ctx.ui.confirm(`Start ${workerPhase}?`, 'Cloud prompts can disclose every mounted input. Confirm inference authority for this fresh phase session.')) return;
          const name = `cleanre-${randomBytes(16).toString('hex')}-${workerPhase}`;
          const run = join(root,'runs',name); const state = join(run,'state'), workspace = join(run,'workspace'), input = join(run,'input');
          // Short socket path avoids Linux sockaddr_un length limits; never mount the project root.
          const socket = join(homedir(),'.local/state',`cr-${randomBytes(12).toString('hex')}`);
          await atomic(join(root,'socket.json'),{path:socket});
          for (const dir of [state,workspace,input,socket]) await mkdir(dir,{recursive:true,mode:0o700});
          const source = join(root,workerPhase === 'research' ? 'originals' : 'approved');
          for (const file of await readdir(source)) {
            if (workerPhase === 'implementation') await transfers.verify(file.replace(/\.json$/,''));
            const bytes = await readRegular(join(source,file),workerPhase === 'research' ? 64*1024*1024 : 262144);
            if (workerPhase === 'research' && digest(bytes) !== file) throw new Error('Original hash mismatch');
            if (workerPhase === 'implementation' && digest(bytes)+'.json' !== file) throw new Error('Snapshot hash mismatch');
            await writeFile(join(input,file),bytes,{flag:'wx',mode:0o400});
          }
          try {
            await probe(lock.image.id,{state,workspace,input,socket},undefined,root);
            active.socket = socket;
            active.broker = await startBroker(join(socket,'inference.sock'),{project,phase:workerPhase,model:ctx.model,maxRequests:100,maxTokens:4096,maxCost:lock.maxCost ?? 1},ctx.modelRegistry);
            await writeFile(join(socket,'worker.json'),JSON.stringify({project,phase:workerPhase,model:lock.model,capability:active.broker.capability}),{flag:'wx',mode:0o400});
            await active.lifecycle.start({image:lock.image.id,name,mounts:{state,workspace,input,socket},socketCleanup:socket});
            workerName = name;
            researchExport = workerPhase === 'research' ? join(workspace, 'export.json') : undefined;
            ctx.ui.notify('Worker ready. /cleanre attach opens the focused panel.', 'info');
          } catch (error) { await active.broker?.close(); active.broker=undefined; await active.lifecycle.close(); await rm(socket,{recursive:true,force:true}); active.socket=undefined; throw error; }
          if (await ctx.ui.confirm('Open worker panel?', 'Esc detaches without stopping the worker.')) await openWorker(ctx.ui);
        } else if (command === 'export') {
          const path = value || researchExport;
          if (!path) throw new Error('Specify export path');
          const id = await transfers.capture(path); ctx.ui.notify(`Quarantine ${id}`,'info');
        } else if (command === 'review') {
          const selected = value || await selectCandidate(transfers, ctx.ui);
          if (!selected) return;
          if (await reviewCandidate(transfers, selected, ctx.ui)) ctx.ui.notify('Exact snapshot approved', 'info');
        } else if (command === 'verify') { await transfers.verify(value); ctx.ui.notify('Snapshot verified','info'); }
        else throw new Error('Unknown cleanre command');
      } catch { ctx.ui.notify('Cleanre refused operation. Check initialization, approved image/model, project lease, input hashes and rootless prerequisites.','error'); }
      finally { busy=false; }
    },
  });
  pi.on('session_shutdown',close);
}
