// Purpose: Preserve Pi stream events across the phase-bound broker transport.
import { request } from 'node:http';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { Api, Model, TranscriptContext, SimpleStreamOptions, AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { Phase } from './backend.ts';
export function brokerStream(socketPath: string, capability: string, project: string, phase: Phase, model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    let terminal = false;
    try {
      const original = { project, phase, model: model.id, context };
      const body = JSON.stringify(await options.onPayload?.(original, model) ?? original);
      const req = request({ socketPath, path: '/infer', method: 'POST', headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' }, signal: options.signal });
      req.setTimeout(120000, () => req.destroy(new Error('Broker timeout')));
      const response = new Promise<import('node:http').IncomingMessage>((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
      req.end(body);
      const res = await response;
      try {
        await options.onResponse?.({ status: res.statusCode ?? 500, headers: { 'content-type': String(res.headers['content-type'] ?? '') } }, model);
        if (res.statusCode !== 200) throw new Error('Broker rejected inference');
        res.setEncoding('utf8'); let pending = '', total = 0, started = false;
        for await (const chunk of res) {
          pending += chunk; total += Buffer.byteLength(chunk);
          if (total > 16777216) throw new Error('Broker response limit');
          let index;
          while ((index = pending.indexOf('\n')) >= 0) {
            const event = JSON.parse(pending.slice(0, index)) as AssistantMessageEvent; pending = pending.slice(index + 1);
            const allowed = ['start','text_start','text_delta','text_end','thinking_start','thinking_delta','thinking_end','toolcall_start','toolcall_delta','toolcall_end','done','error'];
            if (terminal || !allowed.includes(event.type) || (event.type === 'start' && started) || (!started && event.type !== 'start' && event.type !== 'error')) throw new Error('Malformed broker stream');
            if (event.type === 'start') started = true;
            terminal = event.type === 'done' || event.type === 'error';
            stream.push(event);
          }
        }
        if (pending || !terminal) throw new Error('Truncated broker stream');
      } finally { res.destroy(); }
    } catch {
      if (!terminal) {
        const reason = options.signal?.aborted ? 'aborted' : 'error';
        const error: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: reason, errorMessage: reason === 'aborted' ? 'Inference cancelled' : 'Broker transport failed', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'error', reason, error });
      }
    } finally { stream.end(); }
  })();
  return stream;
}
