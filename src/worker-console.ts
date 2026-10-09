// Purpose: Show bounded inert worker output and submit human-authored lines through a disposable attach client.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { Input, Key, isKeyRelease, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { escapedBytes } from './review-screen.ts';
import { PANEL_OVERLAY } from './panel-viewport.ts';
import { containerName } from './backend.ts';

export class WorkerOutput {
  private text = '';
  append(bytes: Buffer) {
    // Byte-wise escaping is chunk-independent, including split UTF-8 and escape sequences.
    const escaped = Array.from(bytes, byte => byte === 10 ? '\n' : escapedBytes([byte])).join('');
    this.text = (this.text + escaped).slice(-32768).split('\n').slice(-160).join('\n');
  }
  value() { return this.text; }
}
export type AttachResult = 'detached' | 'ended' | 'failed' | 'stop';
export type AttachSpawner = (name: string) => ChildProcessWithoutNullStreams;
export const spawnAttach: AttachSpawner = name => {
  containerName(name);
  return spawn('podman', ['attach', '--sig-proxy=false', name], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '' },
    stdio: 'pipe', shell: false,
  });
};
export class WorkerConsole {
  readonly input = new Input({ prompt: 'Human prompt> ' });
  readonly output = new WorkerOutput();
  private child: ChildProcessWithoutNullStreams;
  private disposed = false;
  private resolved = false;
  private offset = 0;
  private sending = false;
  private submitting = false;
  readonly closed: Promise<void>;
  get focused() { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  constructor(name: string, private tui: { requestRender(): void; terminal: { rows: number } }, private done: (result: AttachResult) => void, spawnClient: AttachSpawner = spawnAttach) {
    this.child = spawnClient(name);
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => { this.finish(code === 0 && signal === null ? 'ended' : 'failed'); resolve(); }));
    const append = (bytes: Buffer) => { if (!this.disposed) { this.output.append(bytes); this.tui.requestRender(); } };
    this.child.stdout.on('data', append);
    this.child.stderr.on('data', append);
    this.child.once('error', () => this.finish('failed'));
    this.child.stdin.on('error', () => this.finish('failed'));
    this.input.onSubmit = value => {
      if (!this.submitting || this.disposed || this.sending || !value.trim() || Buffer.byteLength(value) > 8192 || /[\x00-\x1f\x7f-\x9f]/.test(value)) return;
      this.sending = true;
      this.child.stdin.write(value + '\n', error => { this.sending = false; if (error) this.finish('failed'); });
      this.input.setValue('');
      this.tui.requestRender();
    };
  }
  private finish(result: AttachResult) {
    if (this.resolved) return;
    this.resolved = true; this.dispose(); this.done(result);
  }
  invalidate() { this.input.invalidate(); }
  handleInput(data: string) {
    if (this.disposed || isKeyRelease(data)) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) { this.finish('detached'); return; }
    if (matchesKey(data, Key.ctrl('x'))) { this.finish('stop'); return; }
    if (matchesKey(data, Key.pageUp)) this.offset += 5;
    else if (matchesKey(data, Key.pageDown)) this.offset = Math.max(0, this.offset - 5);
    else {
      this.submitting = matchesKey(data, Key.enter) || data === '\n';
      try { this.input.handleInput(data); } finally { this.submitting = false; }
      const value = this.input.getValue();
      const safe = value.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 8192);
      if (safe !== value) this.input.setValue(safe);
    }
    this.tui.requestRender();
  }
  render(width: number): string[] {
    if (width < 24 || this.tui.terminal.rows < 6) return [truncateToWidth('Enlarge panel. Esc detaches.', width)];
    const height = Math.max(1, this.tui.terminal.rows - 5);
    const body = wrapTextWithAnsi(this.output.value() || '(Connected; type a prompt. Startup output is not replayed.)', Math.max(1, width));
    this.offset = Math.min(this.offset, Math.max(0, body.length - height));
    const end = body.length - this.offset;
    return ['Worker output (untrusted, escaped, bounded tail)',
      'Esc/Ctrl+C: detach | Ctrl+X: stop confirmation | PgUp/PgDn: scroll',
      ...body.slice(Math.max(0, end - height), end),
      'Enter sends one human prompt (8192 bytes max). No terminal passthrough.',
      ...this.input.render(width)].map(line => truncateToWidth(line, width));
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.input.setValue('');
    // Never end stdin: EOF can reach the worker. Kill only the local attach client,
    // with signal proxy disabled, then wait for its close before returning authority.
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }
}
export async function attachWorker(name: string, ui: ExtensionUIContext): Promise<AttachResult> {
  let component: WorkerConsole | undefined;
  try {
    return await ui.custom<AttachResult>((tui, _theme, _keys, done) => {
      component = new WorkerConsole(name, tui, done);
      return component;
    }, { overlay: true, overlayOptions: PANEL_OVERLAY });
  } finally {
    component?.dispose();
    await component?.closed;
  }
}
