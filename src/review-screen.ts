// Purpose: Present validated candidates and gate exact-byte approval behind complete human pagination.
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { Key, isKeyRelease, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PanelViewport, PANEL_OVERLAY } from './panel-viewport.ts';
import { Transfers, hashId } from './transfer.ts';

export function escapedBytes(bytes: Iterable<number>): string {
  return Array.from(bytes, byte => byte >= 32 && byte <= 126 && byte !== 92 ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`).join('');
}

// Review rendering keeps LF as a layout newline. Every other byte that could
// alter layout or encoding is represented by a fixed-width reversible escape.
export function reviewText(bytes: Iterable<number>): string {
  return Array.from(bytes, byte => byte === 0x0a ? '\n' : byte >= 0x20 && byte <= 0x7e && byte !== 0x5c ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`).join('');
}
export function decodeReviewText(text: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && /^\\x[0-9a-fA-F]{2}/.test(text.slice(i, i + 4))) { out.push(Number.parseInt(text.slice(i + 2, i + 4), 16)); i += 4; }
    else { out.push(text.charCodeAt(i++)); }
  }
  return Buffer.from(out);
}
export interface ReviewTerminal { requestRender(): void; terminal: { rows: number; columns: number } }
export class ReviewScreen {
  private page = 0;
  private pages = 1;
  private seen = new Set<number>();
  private width = 0;
  private rows = 0;
  private rendered = false;
  private resolved = false;
  private text: string;
  private lines = 0;
  readonly viewport: PanelViewport;
  constructor(readonly id: string, bytes: Buffer, private tui: ReviewTerminal, private done: (approved: boolean) => void) {
    this.viewport = new PanelViewport(tui.terminal);
    hashId(id);
    this.text = reviewText(Buffer.from(bytes));
  }
  invalidate() { this.rendered = false; }
  dispose() { this.resolved = true; }
  handleInput(data: string) {
    if (this.resolved || isKeyRelease(data)) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl('c')) || data === 'n') {
      this.resolved = true; this.done(false); return;
    }
    // Credit only on human navigation/approval after the compositor published bounds.
    if (this.rendered && this.viewport.visible(this.width, this.rows, this.lines)) this.seen.add(this.page);
    else { this.seen.clear(); this.rendered = false; }
    if (data === 'a' && this.rendered && this.width === this.tui.terminal.columns && this.rows === this.tui.terminal.rows && this.seen.size === this.pages && this.page === this.pages - 1) {
      this.resolved = true; this.done(true); return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.pageDown)) this.page = Math.min(this.pages - 1, this.page + 1);
    if (matchesKey(data, Key.left) || matchesKey(data, Key.pageUp)) this.page = Math.max(0, this.page - 1);
    this.rendered = false;
    this.tui.requestRender();
  }
  render(width: number): string[] {
    this.viewport.beginRender();
    const rows = this.tui.terminal.rows;
    if (this.width !== width || this.rows !== rows) {
      this.width = width; this.rows = rows; this.page = 0; this.seen.clear(); this.rendered = false;
    }
    if (width < 72 || rows < 12) {
      this.rendered = false;
      return [truncateToWidth('Enlarge to 72 columns / 12 rows. Esc denies.', width)];
    }
    const panelWidth = Math.min(width, 100);
    const inner = panelWidth - 4;
    const renderedLines: string[] = [];
    const logical = this.text.split('\n');
    logical.forEach((line, index) => {
      while (line.length > inner) {
        renderedLines.push(line.slice(0, inner) + '→');
        line = line.slice(inner);
      }
      renderedLines.push(line + (index < logical.length - 1 ? '↵' : '■'));
    });
    const contentRows = Math.max(1, rows - 8);
    this.pages = Math.max(1, Math.ceil(renderedLines.length / contentRows));
    const body = renderedLines.slice(this.page * contentRows, (this.page + 1) * contentRows);
    this.rendered = true;
    const lines = ['═ CLEANRE: exact candidate bytes (untrusted) ═', this.id,
      'Escaped: \\xHH; row endings: ↵ LF, → wrap, ■ end (not bytes).',
      'Decode: join rows, ↵ = LF; remove →/■; decode \\xHH.',
      ...body, `Page ${this.page + 1}/${this.pages}; viewed ${this.seen.size}/${this.pages}`,
      'Left/Right/PgUp/PgDn: pages | a: continue to confirmation',
      'Enter/Esc/Ctrl+C/n: deny', '═ END CLEANRE REVIEW ═'].map(line => truncateToWidth(line, panelWidth));
    this.lines = lines.length;
    if (lines.length > rows) { this.rendered = false; this.seen.clear(); return []; }
    return lines;
  }
}
export const CUSTOM_HASH = 'Custom exact SHA-256...';
export async function selectCandidate(transfers: Transfers, ui: Pick<ExtensionUIContext, 'select' | 'input'>): Promise<string | undefined> {
  const approved = new Set(await readdir(join(transfers.root, 'approved')));
  const options = new Map<string, string>();
  for (const file of (await readdir(join(transfers.root, 'quarantine'))).sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(file) || approved.has(file)) continue;
    const id = file.slice(0, -5);
    try {
      const bytes = await transfers.candidate(id);
      const value = JSON.parse(bytes.toString('utf8'));
      options.set(`${id} | ${bytes.length} bytes | ${value.fixtures.length} fixtures | ${value.provenance.length} sources`, id);
    } catch { /* Invalid artifacts do not enter the approval picker. */ }
  }
  const selected = await ui.select('Pending candidates (selection is not approval)', [...options.keys(), CUSTOM_HASH]);
  if (selected === CUSTOM_HASH) {
    const typed = await ui.input('Exact SHA-256 to review (not approve)');
    return typed === undefined ? undefined : hashId(typed);
  }
  return selected === undefined ? undefined : options.get(selected);
}
export async function reviewCandidate(transfers: Transfers, id: string, ui: ExtensionUIContext): Promise<boolean> {
  const bytes = await transfers.candidate(id);
  let screen: ReviewScreen | undefined;
  const approved = await ui.custom<boolean>((tui, _theme, _keys, done) => {
    screen = new ReviewScreen(id, bytes, tui, done);
    return {
      render: width => { const lines = screen!.render(width); screen!.viewport.compose(); return lines; },
      handleInput: data => screen!.handleInput(data),
      invalidate: () => screen!.invalidate(),
      dispose: () => screen!.dispose(),
    };
  }, { overlay: true, overlayOptions: PANEL_OVERLAY, onHandle: handle => screen?.viewport.bind(handle) });
  if (approved !== true) return false;
  const attest = 'I reviewed the complete artifact; approve exact snapshot';
  if (await ui.select(`Approve ${id}?`, ['Cancel', attest]) !== attest) return false;
  await transfers.approve(id, bytes);
  return true;
}
