// Purpose: Require the packaged Pi process to distinguish reservation exhaustion from transport failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
test('installed Pi registry completes four turns only with sufficient approved reservation', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cr-runtime-'));
  const result = join(root, 'result.json');
  try {
    const child = promisify(execFile)(process.env.CLEANRE_TEST_PI ?? 'pi', ['--offline', '--no-approve', '-ne', '-ns', '-np', '-nc', '--no-session', '-e', resolve('test/packaged-runtime.ts'), '--provider', 'cleanre-test', '--model', 'fixture', '-p', '/cleanre-test'], { env: { ...process.env, PI_CODING_AGENT_DIR: root, CLEANRE_TEST_RESULT: result }, timeout: 50000 });
    child.child.stdin?.end();
    await child;
    const evidence = JSON.parse(await readFile(result, 'utf8'));
    assert.equal(evidence.calls, 7);
    assert.deepEqual(evidence.results[0].turns, [{ stop: 'stop' }, { stop: 'stop' }, { stop: 'stop' }, { stop: 'error', error: 'Broker rejected inference (HTTP 429, reservation-limit)' }]);
    assert.deepEqual(evidence.results[1].turns, Array.from({ length: 4 }, () => ({ stop: 'stop' })));
  } finally { await rm(root, { recursive: true, force: true }); }
});
