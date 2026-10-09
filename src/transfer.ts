// Purpose: Capture bounded behavioral candidates and publish exact human-approved snapshots.
import { constants } from 'node:fs';
import { open, mkdir, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';

export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function hashId(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Expected a SHA-256 ID');
  return id;
}
export function validateCandidate(bytes: Buffer): void {
  if (bytes.length > 262144) throw new Error('Candidate exceeds 256 KiB');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Candidate must contain valid UTF-8 JSON'); }
  if (!value || Object.keys(value).sort().join(',') !== 'behavior,fixtures,provenance,schema' || value.schema !== 1)
    throw new Error('Expected schema 1 behavioral candidate');
  if (typeof value.behavior !== 'string' || !value.behavior.trim() || value.behavior.length > 100000)
    throw new Error('Behavior must be bounded nonempty text');
  if (!Array.isArray(value.fixtures) || value.fixtures.length > 100 || !value.fixtures.every((v: unknown) => typeof v === 'string'))
    throw new Error('Fixtures must be at most 100 reviewed strings');
  if (!Array.isArray(value.provenance) || !value.provenance.length || value.provenance.length > 100 ||
      !value.provenance.every((v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 2048))
    throw new Error('Provenance requires bounded source declarations');
}
export async function readRegular(path: string, limit = 262144): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error('Expected bounded regular file without links');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await fd.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await fd.stat();
    if (length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('File changed during capture');
    return buffer.subarray(0, length);
  } finally { await fd.close(); }
}
async function publish(path: string, bytes: Buffer): Promise<void> {
  const temp = `${path}.${randomUUID()}`;
  const fd = await open(temp, 'wx', 0o400);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  try { await link(temp, path); } finally { await unlink(temp); }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export class Transfers {
  constructor(readonly root: string) {}
  async init() {
    for (const dir of ['quarantine', 'approved']) await mkdir(join(this.root, dir), { recursive: true, mode: 0o700 });
  }
  async capture(path: string): Promise<string> {
    const source = await readRegular(path);
    validateCandidate(source);
    // Only this canonical representation crosses quarantine and approval boundaries.
    const bytes = Buffer.from(JSON.stringify(JSON.parse(source.toString('utf8')), null, 2));
    validateCandidate(bytes);
    const id = digest(bytes);
    await publish(join(this.root, 'quarantine', `${id}.json`), bytes);
    return id;
  }
  async candidate(id: string): Promise<Buffer> {
    const bytes = await readRegular(join(this.root, 'quarantine', `${hashId(id)}.json`));
    if (digest(bytes) !== id) throw new Error('Candidate hash mismatch');
    validateCandidate(bytes);
    if (!bytes.equals(Buffer.from(JSON.stringify(JSON.parse(bytes.toString('utf8')), null, 2))))
      throw new Error('Candidate is not canonical; export it again');
    return bytes;
  }
  async approve(id: string, reviewed: Buffer): Promise<void> {
    if (digest(reviewed) !== hashId(id)) throw new Error('Reviewed content hash mismatch');
    const current = await this.candidate(id);
    if (!current.equals(reviewed)) throw new Error('Candidate changed after review');
    // Approval is called only after the TUI confirmation, never through a registered tool.
    await publish(join(this.root, 'approved', `${id}.json`), reviewed);
  }
  async verify(id: string): Promise<void> {
    const bytes = await readRegular(join(this.root, 'approved', `${hashId(id)}.json`));
    if (digest(bytes) !== id) throw new Error('Approved snapshot hash mismatch');
    validateCandidate(bytes);
    if (!bytes.equals(Buffer.from(JSON.stringify(JSON.parse(bytes.toString('utf8')), null, 2)))) throw new Error('Approved snapshot is not canonical');
  }
}
