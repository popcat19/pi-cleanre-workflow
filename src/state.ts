// Purpose: Persist controller ownership atomically and hold an exclusive project lease.
import { spawn } from 'node:child_process';
import { mkdir, open, rename, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function atomic(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}`; const fd = await open(temp, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
  await rename(temp, path); const dir = await open(dirname(path), 'r'); try { await dir.sync(); } finally { await dir.close(); }
}
export async function json(path: string): Promise<any> { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Invalid controller state'); } }
export async function lease(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const child = spawn('flock', ['--exclusive','--nonblock',`${root}/controller.lock`,'node','-e',"process.stdout.write('READY\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], { stdio: ['pipe','pipe','ignore'], shell: false });
  const exited = new Promise<void>(resolve=>child.once('close',()=>resolve()));
  await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',()=>resolve());child.once('close',()=>reject(new Error('Another controller owns this project or flock unavailable')));});
  let closed=false; return async()=>{if(!closed){closed=true;child.stdin.end();await exited;}};
}
