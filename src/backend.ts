// Purpose: Enforce rootless OCI prerequisites and construct isolated worker argv.
import { spawn, execFileSync } from 'node:child_process';
export type Phase = 'research' | 'implementation';
export function phase(value: string): Phase { if (value !== 'research' && value !== 'implementation') throw new Error('Unknown phase'); return value; }
export function safeEnv() { return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/worker', PI_CODING_AGENT_DIR: '/worker/agent', TMPDIR: '/tmp', XDG_CACHE_HOME: '/worker/cache', LANG: 'C.UTF-8' }; }
export function imagePin(value: string) { if (!/^(sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64})$/.test(value)) throw new Error('An immutable OCI digest or image ID is required'); return value; }
export function containerName(value: string) { if (!/^cleanre-[a-f0-9]{32}-(research|implementation)$/.test(value)) throw new Error('Invalid container name'); return value; }
export interface Mounts { state: string; input: string; socket: string; workspace: string }
export function runPlan(image: string, name: string, mounts: Mounts): string[] {
  imagePin(image); containerName(name);
  const paths = Object.values(mounts);
  for (const p of paths) if (!p.startsWith('/') || /[,\n\r:]/.test(p)) throw new Error('Unsafe mount path');
  for (const a of paths) for (const b of paths) if (a !== b && (a.startsWith(b + '/') || b.startsWith(a + '/'))) throw new Error('Overlapping mounts');
  if (new Set(paths).size !== paths.length) throw new Error('Aliased mounts');
  return ['run', '--detach', '--interactive', '--tty', '--name', name, '--label', `cleanre.owner=${name}`, '--pull=never', '--network=none', '--userns=keep-id', '--cap-drop=all', '--security-opt=no-new-privileges', '--read-only', '--pids-limit=256', '--memory=2g', '--ipc=private', '--tmpfs=/tmp:rw,nosuid,nodev,size=256m', '--workdir=/workspace',
    ...Object.entries({ state: '/worker', input: '/input', socket: '/broker', workspace: '/workspace' }).flatMap(([key, target]) => ['--mount', `type=bind,src=${mounts[key as keyof Mounts]},dst=${target},${key === 'state' || key === 'workspace' ? 'rw' : 'ro'}`]),
    ...Object.entries(safeEnv()).flatMap(([key, value]) => ['--env', `${key}=${value}`]), image];
}
export type Runner = (args: string[]) => Promise<{ code: number; stdout: string }>;
export const podman: Runner = args => new Promise((resolve, reject) => {
  const env: Record<string,string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const key of ['HOME','XDG_RUNTIME_DIR']) if (process.env[key]) env[key] = process.env[key]!;
  const child = spawn('podman', args, { env, stdio: ['ignore','pipe','ignore'], shell: false });
  let stdout = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1048576) child.kill('SIGKILL'); });
  child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout }); });
});
export async function prerequisites(runner: Runner = podman) {
  execFileSync('flock',['--version'],{stdio:'ignore',timeout:5000});
  const result = await runner(['info','--format=json']); if (result.code) throw new Error('Podman info failed');
  const info = JSON.parse(result.stdout); const host = info.host;
  if (!host?.security?.rootless || host.cgroupVersion !== 'v2' || !['memory','pids'].every(c => host.cgroupControllers?.includes(c))) throw new Error('Rootless Podman with cgroup v2 memory and pids controllers required');
  return ['Rootless Podman; memory and PID limits available', 'CPU quota is optional and not configured'];
}
export async function doctor(runner: Runner = podman) { try { return await prerequisites(runner); } catch { return ['BLOCKED: rootless Podman with memory/PID limits required']; } }
