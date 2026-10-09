// Purpose: Pin worker resource content and resolve locally available immutable image identities.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { digest } from './transfer.ts';
import { imagePin, podman, type Runner } from './backend.ts';
export async function resources() {
  const base = fileURLToPath(new URL('../', import.meta.url));
  const files = ['package-lock.json','Containerfile','src/worker.ts','src/adapter.ts','src/backend.ts'];
  return Object.fromEntries(await Promise.all(files.map(async f => [f,digest(await readFile(join(base,f)))])));
}
export async function verifyImageResources(id: string, expected: Record<string,string>, runner: Runner = podman) {
  const script = `const fs=require('fs'),c=require('crypto');for(const [f,h] of Object.entries(${JSON.stringify(expected)})){if(c.createHash('sha256').update(fs.readFileSync('/opt/cleanre/'+f)).digest('hex')!==h)process.exit(1)}`;
  const result = await runner(['run','--rm','--pull=never','--network=none','--read-only','--userns=keep-id','--cap-drop=all','--security-opt=no-new-privileges','--entrypoint=/usr/local/bin/node',imagePin(id),'-e',script]);
  if(result.code)throw new Error('Image does not contain the approved worker resources');
}
export async function inspectImage(ref: string, runner: Runner = podman) {
  imagePin(ref); const result = await runner(['image','inspect',ref]); if (result.code) throw new Error('Reviewed image must already be prefetched');
  const image = JSON.parse(result.stdout)[0]; image.Id = image.Id.startsWith('sha256:') ? image.Id : 'sha256:' + image.Id; imagePin(image.Id);
  return { reference: ref, id: image.Id, repoDigests: image.RepoDigests ?? [] };
}
