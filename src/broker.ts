// Purpose: Relay bounded phase-capability inference over a private Unix socket without tool execution.
import { createServer } from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { Api, Model, TranscriptContext } from '@earendil-works/pi-ai';
import type { Phase } from './backend.ts';
import { TranscriptGuard } from './transcript.ts';

export function catalog(model: Model<Api>) {
  return { id: model.id, name: model.id, reasoning: model.reasoning, input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite } };
}
export interface BrokerConfig { project: string; phase: Phase; model: Model<Api>; maxRequests: number; maxTokens: number; maxCost: number }
export async function startBroker(path: string, config: BrokerConfig, registry: Pick<ModelRegistry, 'streamSimple'>) {
  for (const value of [config.maxRequests, config.maxTokens, config.maxCost]) if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid broker limit');
  const capability = randomBytes(32).toString('hex');
  const active = new Set<AbortController>();
  const transcript = new TranscriptGuard();
  let requests = 0, spent = 0, closed = false;
  const server = createServer(async (req, res) => {
    const header = req.headers.authorization ?? '';
    const supplied = /^Bearer [a-f0-9]{64}$/.test(header) ? Buffer.from(header.slice(7), 'ascii') : undefined;
    const expected = Buffer.from(capability, 'ascii');
    if (closed || !supplied || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403).end(); return; }
    if (req.method !== 'POST' || req.url !== '/infer') { res.writeHead(404).end(); return; }
    const reject = (status: number, code: string) => { res.writeHead(status, { 'x-cleanre-error': code }).end(); };
    if (active.size) { reject(429, 'concurrent-request'); return; }
    if (requests >= config.maxRequests) { reject(429, 'request-limit'); return; }
    if (spent >= config.maxCost) { reject(429, 'reservation-limit'); return; }
    const abort = new AbortController(); active.add(abort);
    const timer = setTimeout(() => { abort.abort(); req.destroy(); res.destroy(); }, 120000);
    res.on('close', () => abort.abort());
    let failure = 'invalid-request';
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1048576) throw new Error('Request too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (Object.keys(body).sort().join(',') !== 'context,model,phase,project' || body.project !== config.project || body.phase !== config.phase || body.model !== config.model.id || !body.context || Object.keys(body.context).join(',') !== 'messages' || !Array.isArray(body.context.messages)) throw new Error('Invalid request');
      failure = 'invalid-transcript';
      transcript.validate(body.context.messages);
      failure = 'invalid-pricing';
      // Reserve the whole per-request worst-case estimate; unknown cost metadata fails closed.
      const rates = Object.values(catalog(config.model).cost);
      if (rates.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Unknown pricing');
      const reservation = (config.model.contextWindow * Math.max(...rates) + config.maxTokens * config.model.cost.output) / 1e6;
      if (spent + reservation > config.maxCost) { reject(429, 'reservation-limit'); return; }
      spent += reservation; requests++;
      failure = 'upstream-stream';
      const stream = registry.streamSimple(config.model, body.context as TranscriptContext, { signal: abort.signal, maxTokens: config.maxTokens });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      let terminal = false, bytes = 0;
      for await (const event of stream) {
        if (abort.signal.aborted) break;
        const safeEvent = event.type === 'error' ? { ...event, error: { ...event.error, errorMessage: 'Upstream inference failed' } } : event;
        if (safeEvent.type === 'done') transcript.issue(safeEvent.message);
        if (safeEvent.type === 'error') transcript.issue(safeEvent.error);
        const line = JSON.stringify(safeEvent) + '\n'; bytes += Buffer.byteLength(line);
        if (bytes > 16777216 || terminal) throw new Error('Invalid upstream stream');
        terminal = event.type === 'done' || event.type === 'error';
        if (!res.write(line)) await new Promise<void>((resolve, reject) => { res.once('drain', resolve); res.once('close', () => reject(new Error('Disconnected'))); });
      }
      if (!terminal && !abort.signal.aborted) throw new Error('Missing terminal event');
      res.end();
    } catch { if (!res.headersSent) reject(failure === 'upstream-stream' ? 502 : 400, failure); else res.destroy(); }
    finally { abort.abort(); clearTimeout(timer); active.delete(abort); }
  });
  server.maxConnections = 4; server.requestTimeout = 120000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  return { capability, async close() { if (closed) return; closed = true; for (const abort of active) abort.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await unlink(path).catch(() => {}); } };
}
