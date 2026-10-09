// Purpose: Exercise broker request reservations through the installed Pi extension model registry without cloud calls.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker } from '../src/broker.ts';
import { brokerStream } from '../src/adapter.ts';
export default function testRuntime(pi: ExtensionAPI) {
  let calls = 0;
  pi.registerProvider('cleanre-test', {
    baseUrl: 'http://disabled.invalid', api: 'openai-completions', apiKey: 'synthetic',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 272000, maxTokens: 4096, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }],
    streamSimple(model) {
      calls++;
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant' as const, api: model.api, provider: model.provider, model: model.id, timestamp: 0, content: [{ type: 'text' as const, text: 'synthetic' }], stopReason: 'stop' as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: 'start', partial: { ...message, stopReason: 'pending' } });
      stream.push({ type: 'done', reason: 'stop', message }); stream.end(); return stream;
    },
  });
  pi.registerCommand('cleanre-test', { description: 'Offline broker regression', handler: async (_args, ctx) => {
    const root = await mkdtemp(join(tmpdir(), 'cr-packaged-'));
    const model = ctx.modelRegistry.find('cleanre-test', 'fixture')!;
    const results = [];
    try {
      for (const maxCost of [1, 3]) {
        const broker = await startBroker(join(root, 's'), { project: 'p', phase: 'research', model, maxRequests: 100, maxTokens: 4096, maxCost }, ctx.modelRegistry);
        const turns = [];
        try {
          for (let i = 0; i < 4; i++) {
            const result = await brokerStream(join(root, 's'), broker.capability, 'p', 'research', model, normalizeContext({ messages: [] })).result();
            turns.push({ stop: result.stopReason, error: result.errorMessage });
          }
        } finally { await broker.close(); }
        results.push({ maxCost, turns });
      }
      await writeFile(process.env.CLEANRE_TEST_RESULT!, JSON.stringify({ calls, results }));
    } finally { await rm(root, { recursive: true, force: true }); }
  } });
}
