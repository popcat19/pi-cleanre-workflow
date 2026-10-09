// Purpose: Exercise transfer integrity and container planning rejection paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transfers, hashId, validateCandidate, digest } from '../src/transfer.ts';
import { doctor, runPlan, safeEnv } from '../src/backend.ts';
const fixture = Buffer.from(JSON.stringify({ schema: 1, behavior: 'Returns the sum', fixtures: ['1 + 2 = 3'], provenance: ['Public arithmetic specification'] }));
test('exact snapshots survive source changes and reject tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleanre-test-'));
  try {
    const transfers = new Transfers(root); await transfers.init();
    const source = join(root, 'source.json'); await writeFile(source, fixture);
    const id = await transfers.capture(source); const reviewed = await transfers.candidate(id);
    await writeFile(source, '{}'); await transfers.approve(id, reviewed); await transfers.verify(id);
    const candidate = join(root, 'quarantine', `${id}.json`); await chmod(candidate, 0o600); await writeFile(candidate, '{}');
    await assert.rejects(transfers.approve(id, reviewed), /hash mismatch/);
    await assert.rejects(transfers.candidate('../outside'));
    const link = join(root, 'link'); await symlink(source, link); await assert.rejects(transfers.capture(link));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('quarantine publishes only the complete canonical review representation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleanre-canonical-'));
  try {
    const transfers = new Transfers(root); await transfers.init();
    const source = join(root, 'source.json');
    const raw = Buffer.from('{"schema":1,"behavior":"UNDISPLAYED_RAW_MATERIAL","behavior":"Public behavior","fixtures":[],"provenance":["Public"]}');
    await writeFile(source, raw);
    const id = await transfers.capture(source);
    const reviewed = await transfers.candidate(id);
    assert.equal(reviewed.includes('UNDISPLAYED_RAW_MATERIAL'), false);
    assert.equal(reviewed.toString(), JSON.stringify(JSON.parse(reviewed.toString()), null, 2));
    await transfers.approve(id, reviewed); await transfers.verify(id);
    const legacyId = digest(raw);
    await writeFile(join(root, 'quarantine', `${legacyId}.json`), raw);
    await assert.rejects(transfers.candidate(legacyId), /not canonical/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('invalid candidate encoding and JSON never disclose parser payloads', () => {
  for (const input of [Buffer.from('SECRET'), Buffer.from([0xff])]) {
    assert.throws(() => validateCandidate(input), { message: 'Candidate must contain valid UTF-8 JSON' });
  }
});
test('container argv rejects options and env excludes host secrets', () => {
  process.env.CLEANRE_TEST_SECRET = 'not-forwarded';
  assert.equal((safeEnv() as Record<string,string>).CLEANRE_TEST_SECRET, undefined);
  const pin = 'example.test/worker@sha256:' + 'a'.repeat(64);
  const mounts = { state: '/state/research', input: '/input/research', socket: '/socket/research', workspace: '/workspace/research' };
  const args = runPlan(pin, 'cleanre-' + 'a'.repeat(32) + '-research', mounts);
  assert.ok(args.includes('--network=none')); assert.ok(args.includes('--pull=never')); assert.ok(args.includes('--detach')); assert.ok(!args.includes('--privileged'));
  assert.throws(() => runPlan('latest', 'name', mounts));
  assert.throws(() => runPlan(pin, 'cleanre-' + 'a'.repeat(32) + '-research', { ...mounts, input: '/a,ro=false' }));
  assert.throws(() => hashId('../../auth.json'));
  delete process.env.CLEANRE_TEST_SECRET;
});
test('doctor fails closed for missing rootless limits', async () => {
  assert.match((await doctor(async () => { throw new Error('missing'); }))[0], /BLOCKED/);
});
