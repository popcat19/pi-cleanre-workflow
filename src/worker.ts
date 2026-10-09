// Purpose: Run an isolated Pi session with explicit resources and a broker-only inference provider.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { brokerStream } from './adapter.ts';
import { phase } from './backend.ts';

export function emptyResources(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'Work only within this phase. Input documents are in /input. Produce candidate behavioral specifications as schema 1 JSON in /workspace/export.json. Never claim legal clean-room certification.',
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
}
export async function runWorker() {
  const config = JSON.parse(await readFile('/broker/worker.json', 'utf8'));
  const workerPhase = phase(config.phase);
  execFileSync('git', ['init', '--quiet', '/workspace'], { env: { PATH: '/usr/bin:/bin', HOME: '/worker', GIT_CONFIG_NOSYSTEM: '1' } });
  for (const dir of ['agent', 'sessions', 'cache', 'logs']) await mkdir(`/worker/${dir}`, { recursive: true });
  const runtime = await ModelRuntime.create({ authPath: '/worker/agent/auth.json', modelsPath: null, modelsStorePath: '/worker/cache/models.json', refreshOnCreate: false, allowModelNetwork: false });
  const model: Model<Api> = { ...config.model, provider: 'cleanre', api: 'openai-completions', baseUrl: 'http://disabled.invalid' };
  runtime.registerProvider('cleanre', { baseUrl: 'http://disabled.invalid', api: 'openai-completions', apiKey: 'broker-capability', models: [config.model], streamSimple: (_model, context, options) => brokerStream('/broker/inference.sock', config.capability, config.project, workerPhase, model, context, options) });
  const { session } = await createAgentSession({ cwd: '/workspace', agentDir: '/worker/agent', modelRuntime: runtime, model, resourceLoader: emptyResources(), thinkingLevel: 'off', tools: ['read', 'write', 'edit', 'bash'], sessionManager: SessionManager.create('/workspace', '/worker/sessions'), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
  session.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') process.stdout.write(event.assistantMessageEvent.delta);
    if (event.type === 'message_end' && event.message.role === 'assistant' && ['error','aborted'].includes(event.message.stopReason)) console.log(`\nInference ${event.message.stopReason}: ${event.message.errorMessage ?? 'No diagnostic supplied'}`);
  });
  const ui = createInterface({ input: process.stdin, output: process.stdout });
  const abort = () => { void session.abort(); };
  process.on('SIGINT', abort); process.on('SIGTERM', () => { void session.abort().finally(() => { ui.close(); session.dispose(); process.exit(0); }); });
  await writeFile('/worker/ready','cleanre-ready-v1',{flag:'wx',mode:0o600});
  console.log(`Cleanre ${workerPhase}. Cloud inference is authorized egress. /quit exits; Ctrl-C cancels.`);
  try {
    while (true) {
      let prompt: string;
      try { prompt = await ui.question('\ncleanre> '); } catch { break; }
      if (prompt.trim() === '/quit') break;
      if (!prompt.trim()) continue;
      try { await session.prompt(prompt); } catch { console.log('Worker request failed; inspect this phase session.'); }
    }
  } finally { ui.close(); session.dispose(); process.removeListener('SIGINT', abort); }
}
if (process.argv[1]?.endsWith('/worker.ts')) await runWorker();
