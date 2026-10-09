// Purpose: Verify inert worker rendering, attach cleanup, exact picker identity and complete human review gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { visibleWidth } from '@earendil-works/pi-tui';
import { WorkerOutput, WorkerConsole } from '../src/worker-console.ts';
import { ReviewScreen, escapedBytes, reviewText, decodeReviewText, selectCandidate, reviewCandidate, CUSTOM_HASH } from '../src/review-screen.ts';
import { panelLayout } from './panel-layout.ts';
import { PANEL_OVERLAY } from '../src/panel-viewport.ts';
import { stripVTControlCharacters } from 'node:util';
import { Transfers, digest } from '../src/transfer.ts';
const terminal = () => ({ terminal: { rows: 15, columns: 80 }, requestRender() {} });

test('review pages preserve JSON newlines, controls, unicode and backslashes', () => {
  const bytes = Buffer.from('{"behavior":"line1\nline2","value":"雪\\ok"}\n\r\0', 'utf8');
  assert.deepEqual(decodeReviewText(reviewText(bytes)), bytes);
  assert.match(reviewText(bytes), /\n/);
  assert.ok(reviewText(bytes).includes('\\x0d'));
  assert.ok(reviewText(bytes).includes('\\xe9'));
  assert.ok(reviewText(bytes).includes('\\x5c'));
});

test('byte escaping is reversible and inert across every split; worker tail is bounded', () => {
  const bytes = Buffer.from('before\x1b]52;c;secret\x07\r\x1b[2J\u202e雪\\after\n');
  const all = new WorkerOutput(); all.append(bytes);
  for (let i = 0; i < bytes.length; i++) {
    const split = new WorkerOutput(); split.append(bytes.subarray(0, i)); split.append(bytes.subarray(i));
    assert.equal(split.value(), all.value());
  }
  assert.doesNotMatch(all.value(), /[\x00-\x09\x0b-\x1f\x7f-\uffff]/);
  const encoded = escapedBytes(bytes);
  const decoded: number[] = [];
  for (let i = 0; i < encoded.length;) {
    if (encoded[i] === '\\') { decoded.push(parseInt(encoded.slice(i + 2, i + 4), 16)); i += 4; }
    else decoded.push(encoded.charCodeAt(i++));
  }
  assert.deepEqual(Buffer.from(decoded), bytes);
  all.append(Buffer.alloc(100000, 65)); assert.ok(all.value().length <= 32768);
  all.append(Buffer.from('line\n'.repeat(1000))); assert.ok(all.value().split('\n').length <= 160);
});

function client() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kills: [] as string[], kill(signal: string) { this.kills.push(signal); queueMicrotask(() => child.emit('close', null, signal)); return true; } });
  return child;
}
test('Input owns focus and submits lines only; detach kills client without stdin EOF', async () => {
  const child = client(), results: string[] = [], writes: string[] = [];
  child.stdin.on('data', bytes => writes.push(bytes.toString()));
  const panel = new WorkerConsole('name', terminal(), r => results.push(r), () => child as unknown as ChildProcessWithoutNullStreams);
  panel.focused = true; assert.equal(panel.input.focused, true);
  panel.handleInput('\x1b[200~\x1b]52;evil\x07\u202e\x1b[201~');
  assert.doesNotMatch(panel.input.getValue(), /[\x00-\x1f\u202e]/);
  panel.input.setValue('');
  panel.handleInput('hello'); assert.deepEqual(writes, []);
  panel.handleInput('\r'); assert.deepEqual(writes, ['hello\n']);
  child.stdout.write('\x1b]52;evil\x07');
  for (const width of [10, 80]) assert.ok(panel.render(width).every(line => visibleWidth(line) <= width));
  panel.handleInput('\x1b'); await panel.closed;
  assert.deepEqual(results, ['detached']); assert.deepEqual(child.kills, ['SIGKILL']);
  assert.equal(child.stdin.writableEnded, false);
  panel.dispose(); panel.handleInput('ignored'); assert.equal(writes.length, 1);
});
test('attach exit, spawn error, stdin error and disposal are idempotent', async () => {
  for (const event of ['close', 'error', 'stdin', 'dispose']) {
    const child = client(), results: string[] = [];
    const panel = new WorkerConsole('name', terminal(), r => results.push(r), () => child as unknown as ChildProcessWithoutNullStreams);
    if (event === 'stdin') child.stdin.emit('error', Error('broken pipe'));
    else if (event === 'dispose') panel.dispose();
    else child.emit(event, event === 'error' ? Error('spawn failed') : 0);
    await panel.closed; panel.dispose(); assert.equal(results.length, 1);
  }
});

test('review credits only compositor-visible pages over crowded dock, including resize', () => {
  const bytes = Buffer.from('x'.repeat(2500)), id = digest(bytes), layout = panelLayout();
  const results: boolean[] = [];
  const screen = new ReviewScreen(id, bytes, layout.tui, r => results.push(r));
  screen.render(80); screen.handleInput('a'); assert.equal(results.length, 0);
  const handle = layout.mount({ render: width => { const lines = screen.render(width); screen.viewport.compose(); return lines; }, invalidate: () => screen.invalidate(), handleInput: data => screen.handleInput(data) }, PANEL_OVERLAY); screen.viewport.bind(handle);
  let composed = layout.compose().map(stripVTControlCharacters);
  assert.ok(composed.some(line => line.includes(id)));
  screen.render(80); screen.handleInput('a'); assert.equal(results.length, 0);
  layout.compose(); screen.handleInput('\x1b[C');
  layout.terminal.rows = 12; layout.terminal.columns = 72;
  screen.handleInput('a'); assert.equal(results.length, 0);
  let recovered = '';
  for (let i = 0; i < 30 && !results.length; i++) {
    composed = layout.compose().map(stripVTControlCharacters);
    const start = composed.findIndex(line => line.startsWith('Decode: join rows,')) + 1;
    const end = composed.findIndex(line => line.startsWith('Page '));
    assert.ok(start > 0 && end >= start);
    recovered += composed.slice(start, end).map(line => line.trimEnd().replace(/[→■]$/, '').replace(/↵$/, '\n')).join('');
    assert.ok(composed.some(line => line.startsWith('Left/Right/PgUp/PgDn: pages')));
    if (/Page (\d+)\/\1;/.test(composed[end])) screen.handleInput('a');
    else screen.handleInput('\x1b[C');
  }
  assert.equal(recovered, escapedBytes(bytes)); assert.deepEqual(results, [true]);
  handle.hide();
  for (const key of ['\r', '\x1b', 'n', '\x03']) {
    const denied: boolean[] = []; const s = new ReviewScreen(id, bytes, layout.tui, r => denied.push(r)); s.render(72); s.handleInput(key); assert.deepEqual(denied, [false]);
  }
});

test('review fails closed on clipped overlay bounds and lost focus', () => {
  const layout = panelLayout(), bytes = Buffer.from('small'), results: boolean[] = [];
  const screen = new ReviewScreen(digest(bytes), bytes, layout.tui, value => results.push(value));
  const component = { render: (width: number) => { const lines = screen.render(width); screen.viewport.compose(); return lines; }, invalidate: () => screen.invalidate() };
  let handle = layout.mount(component, { ...PANEL_OVERLAY, maxHeight: 3 }); screen.viewport.bind(handle);
  layout.compose(); screen.handleInput('a'); assert.equal(results.length, 0); handle.hide();
  handle = layout.mount(component, PANEL_OVERLAY); screen.viewport.bind(handle);
  layout.compose(); handle.setHidden(true); screen.handleInput('a'); assert.equal(results.length, 0);
  handle.setHidden(false); layout.compose();
  const other = layout.mount({ render: () => ['cover'], invalidate() {} }, PANEL_OVERLAY);
  screen.handleInput('a'); assert.equal(results.length, 0); other.hide();
  layout.compose(); screen.handleInput('a'); assert.deepEqual(results, [true]); handle.hide();
});

test('worker overlay keeps controls and focused Input visible above crowded host dock', async () => {
  const layout = panelLayout(), child = client();
  const panel = new WorkerConsole('name', layout.tui, () => {}, () => child as unknown as ChildProcessWithoutNullStreams);
  const handle = layout.mount(panel, PANEL_OVERLAY);
  panel.output.append(Buffer.from('output\n'.repeat(100)));
  for (const rows of [15, 8, 30]) {
    layout.terminal.rows = rows;
    const lines = layout.compose().map(stripVTControlCharacters);
    assert.ok(lines.some(line => line.startsWith('Human prompt>')));
    assert.ok(lines.some(line => line.startsWith('Esc/Ctrl+C: detach')));
    assert.ok(lines.some(line => line.startsWith('Enter sends one human prompt')));
    assert.equal(panel.focused, true);
  }
  panel.handleInput('\x1b'); await panel.closed; handle.hide();
});

test('nonzero attach exit and unexpected signal report failure; deliberate detach retains result', async () => {
  for (const [code, signal] of [[125, null], [null, 'SIGTERM'], [0, null]] as const) {
    const child = client(), results: string[] = [];
    const panel = new WorkerConsole('name', terminal(), r => results.push(r), () => child as unknown as ChildProcessWithoutNullStreams);
    child.stderr.write('untrusted diagnostic'); child.emit('close', code, signal); await panel.closed;
    assert.deepEqual(results, [code === 0 ? 'ended' : 'failed']);
  }
});

test('pending picker maps exact option, custom hash stays review-only, tamper blocks approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleanre-tui-'));
  try {
    const transfers = new Transfers(root); await transfers.init();
    const source = join(root, 'source'); await writeFile(source, JSON.stringify({ schema: 1, behavior: 'sample', fixtures: [], provenance: ['public'] }));
    const id = await transfers.capture(source);
    await writeFile(join(root, 'quarantine', 'f'.repeat(64) + '.json'), '{}');
    let options: string[] = [];
    const picked = await selectCandidate(transfers, { select: async (_title, entries) => { options = entries; return entries[0]; }, input: async () => undefined });
    assert.equal(picked, id); assert.equal(options.length, 2);
    assert.equal(await selectCandidate(transfers, { select: async () => options[0].slice(0, 12), input: async () => undefined }), undefined);
    assert.equal(await selectCandidate(transfers, { select: async () => CUSTOM_HASH, input: async () => id }), id);
    await assert.rejects(selectCandidate(transfers, { select: async () => CUSTOM_HASH, input: async () => id.slice(0, 12) }));
    assert.equal(await reviewCandidate(transfers, id, { custom: async () => false } as any), false);
    assert.equal(await reviewCandidate(transfers, id, { custom: async () => true, select: async (_title: string, options: string[]) => { assert.equal(options[0], 'Cancel'); return options[0]; } } as any), false);
    await assert.rejects(reviewCandidate(transfers, id, { select: async (_title: string, options: string[]) => options[1], custom: async () => { await rm(join(root, 'quarantine', id + '.json')); await writeFile(join(root, 'quarantine', id + '.json'), '{}'); return true; } } as any), /hash mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real Podman piped attach detaches and reattaches without worker EOF', { skip: !process.env.CLEANRE_TEST_IMAGE, timeout: 30000 }, async () => {
  const { podman } = await import('../src/backend.ts');
  const { spawnAttach } = await import('../src/worker-console.ts');
  const { randomBytes } = await import('node:crypto');
  const name = `cleanre-${randomBytes(16).toString('hex')}-research`;
  try {
    const launched = await podman(['run', '-dit', '--pull=never', '--network=none', '--name', name, '--entrypoint=/bin/sh', process.env.CLEANRE_TEST_IMAGE!, '-c', 'while read line; do echo RECEIVED:$line; done']);
    assert.equal(launched.code, 0);
    for (const prompt of ['first', 'reattached']) {
      const child = spawnAttach(name);
      const received = new Promise<void>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(Error('Echo timeout')), 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.stdout.on('data', bytes => { text += bytes.toString(); if (text.includes(`RECEIVED:${prompt}`)) { clearTimeout(timer); resolve(); } });
      });
      const panel = new WorkerConsole(name, terminal(), () => {}, () => child);
      try {
        await new Promise(resolve => setTimeout(resolve, 300));
        panel.handleInput(prompt); panel.handleInput('\r'); await received;
      } finally { panel.handleInput('\x1b'); await panel.closed; }
      const inspected = await podman(['inspect', '--format', '{{.State.Running}}', name]);
      assert.equal(inspected.stdout.trim(), 'true');
    }
  } finally { await podman(['rm', '-f', '--time=0', name]); }
});
