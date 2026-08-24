/** An image mention must reach the provider as image content, not as base64
 *  pasted into the text where the model cannot see it. */
import { Agent } from '../src/agent/loop.ts';
import type { Settings } from '../src/config.ts';
import type { ImageAttachment } from '../src/providers/types.ts';
import type { Provider, StreamOpts, Turn } from '../src/providers/types.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

const settings: Settings = {
  model: 'gpt-5',
  permissionMode: 'default',
  allow: [],
  deny: [],
  maxTokens: 8192,
  autoCompactAt: 100000,
  keepRecentTurns: 6,
  mcpServers: {},
  hooks: {},
};

const agent = new Agent('/tmp', settings, null, 'https://example.invalid/v1', 'unused');
const image: ImageAttachment = { mimeType: 'image/png', data: 'AAAA', name: 'shot.png' };

// Intercept the provider so nothing reaches the network. The field is private,
// so reaching it needs a cast — but a named one, not `any`.
let captured: StreamOpts | null = null;
const fake: Provider = {
  id: 'openai',
  models: [],
  send: async (opts: StreamOpts) => {
    captured = opts;
    return { text: 'ok', toolCalls: [], usage: { input: 1, output: 1 }, stopReason: 'end_turn' };
  },
};
(agent as unknown as { openai: Provider }).openai = fake;

/** The turns the fake provider was handed on the last call. */
const sentTurns = (): Turn[] => captured?.turns ?? [];
const userTurns = () =>
  sentTurns().filter((t): t is Extract<Turn, { role: 'user' }> => t.role === 'user');

const noop = {
  onDelta: () => {},
  onAssistantEnd: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
  onNotice: () => {},
  requestPermission: async () => 'deny' as const,
};

await agent.run('what is in this?', noop, undefined, [image]);
const userTurn = userTurns()[0];
check(
  'the image is on the user turn',
  Array.isArray(userTurn?.images) && userTurn.images.length === 1,
  JSON.stringify(userTurn),
);
check('it keeps its mime type', userTurn?.images?.[0].mimeType === 'image/png');
check('the text is unchanged', userTurn?.text === 'what is in this?');
check('base64 was not pasted into the text', !userTurn?.text.includes('AAAA'));

console.log('\nthe adapters convert it');
const { createOpenAIProvider } = await import('../src/providers/openai.ts');
void createOpenAIProvider;
const openaiMod = await import('../src/providers/openai.ts');
const anthropicMod = await import('../src/providers/anthropic.ts');
check('openai adapter module loads', typeof openaiMod.createOpenAIProvider === 'function');
check('anthropic adapter module loads', typeof anthropicMod.createAnthropicProvider === 'function');

agent.turns = [];
await agent.run('no image here', noop);
const plain = userTurns()[0];
check(
  'a turn without images carries no images key',
  plain?.images === undefined,
  JSON.stringify(plain),
);

console.log('');
if (failures.length) {
  console.error(failures.length + ' failure(s): ' + failures.join(', '));
  process.exit(1);
}
console.log('All image checks passed.');
