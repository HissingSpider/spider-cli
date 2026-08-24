/**
 * The two streaming adapters, against a fake gateway.
 *
 * These parse the most protocol-sensitive code in the project and were covered
 * only by live API calls, which meant any refactor of the SSE payload handling
 * was unverifiable without spending tokens and hoping.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAnthropicProvider } from '../src/providers/anthropic.ts';
import { createOpenAIProvider } from '../src/providers/openai.ts';
import type { Turn } from '../src/providers/types.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

const sse = (frames: unknown[]) =>
  frames.map((f) => 'data: ' + JSON.stringify(f) + '\n\n').join('');

/** Captures what the adapter sent, and replies with a canned stream. */
let lastRequest!: { url: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders };
let reply = '';

const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  lastRequest = {
    url: req.url ?? '',
    body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
    headers: req.headers,
  };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(reply);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;

const TOOLS = [
  {
    name: 'bash',
    description: 'run a command',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
  },
];
const TURNS: Turn[] = [{ role: 'user', text: 'hello' }];

// --- OpenAI Responses ------------------------------------------------------
console.log('\nopenai responses');
reply = sse([
  { type: 'response.output_text.delta', delta: 'Hel' },
  { type: 'response.output_text.delta', delta: 'lo!' },
  {
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [
        { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
      ],
      usage: { input_tokens: 11, output_tokens: 7 },
    },
  },
]);

let streamed = '';
const openai = createOpenAIProvider(base, 'test-key');
const oa = await openai.send({
  model: 'gpt-5',
  system: 'be brief',
  turns: TURNS,
  tools: TOOLS,
  maxTokens: 100,
  onDelta: (d) => {
    streamed += d;
  },
});

check('text deltas are streamed', streamed === 'Hello!', JSON.stringify(streamed));
check('text is accumulated', oa.text === 'Hello!', JSON.stringify(oa.text));
check('a tool call is parsed', oa.toolCalls.length === 1 && oa.toolCalls[0].name === 'bash');
check(
  'tool arguments are parsed from JSON',
  oa.toolCalls[0]?.input.command === 'ls',
  JSON.stringify(oa.toolCalls[0]?.input),
);
check('the call id is carried', oa.toolCalls[0]?.id === 'call_1');
check(
  'usage is reported',
  oa.usage.input === 11 && oa.usage.output === 7,
  JSON.stringify(oa.usage),
);
check('stop reason reflects tool use', oa.stopReason === 'tool_use', oa.stopReason);
check('it hit /responses', lastRequest.url === '/responses', lastRequest.url);
check('the system prompt goes in instructions', lastRequest.body.instructions === 'be brief');
check('bearer auth is sent', lastRequest.headers.authorization === 'Bearer test-key');

// Malformed arguments must not take the turn down.
reply = sse([
  {
    type: 'response.completed',
    response: {
      output: [{ type: 'function_call', call_id: 'c2', name: 'bash', arguments: '{not json' }],
      usage: {},
    },
  },
]);
const broken = await openai.send({
  model: 'gpt-5',
  system: '',
  turns: TURNS,
  tools: TOOLS,
  maxTokens: 100,
  onDelta: () => {},
});
check(
  'malformed tool arguments yield an empty input, not a crash',
  broken.toolCalls.length === 1 && Object.keys(broken.toolCalls[0].input).length === 0,
);

// --- Anthropic Messages ----------------------------------------------------
console.log('\nanthropic messages');
reply = sse([
  { type: 'message_start', message: { usage: { input_tokens: 20 } } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"com' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: 'mand":"ls"}' },
  },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
]);

let anthStreamed = '';
const anthropic = createAnthropicProvider(base, 'test-key');
const an = await anthropic.send({
  model: 'claude-haiku-4-5-20251001',
  system: 'be brief',
  turns: TURNS,
  tools: TOOLS,
  maxTokens: 100,
  onDelta: (d) => {
    anthStreamed += d;
  },
});

check('text deltas are streamed', anthStreamed === 'Hi there', JSON.stringify(anthStreamed));
check('a tool_use block is parsed', an.toolCalls.length === 1 && an.toolCalls[0].name === 'bash');
check(
  'partial_json fragments are reassembled',
  an.toolCalls[0]?.input.command === 'ls',
  JSON.stringify(an.toolCalls[0]?.input),
);
check('the tool_use id is carried', an.toolCalls[0]?.id === 'toolu_1');
check(
  'usage comes from both message_start and message_delta',
  an.usage.input === 20 && an.usage.output === 9,
  JSON.stringify(an.usage),
);
check('stop reason is read', an.stopReason === 'tool_use', an.stopReason);
check('it hit /messages', lastRequest.url === '/messages', lastRequest.url);
check(
  'the anthropic version header is sent',
  lastRequest.headers['anthropic-version'] === '2023-06-01',
);
check(
  'tools are sent with input_schema, not parameters',
  Array.isArray(lastRequest.body.tools) &&
    'input_schema' in (lastRequest.body.tools as Record<string, unknown>[])[0],
  JSON.stringify(lastRequest.body.tools),
);

// Consecutive tool results must merge into one user message or the API rejects them.
const withResults: Turn[] = [
  { role: 'user', text: 'go' },
  {
    role: 'assistant',
    text: '',
    toolCalls: [
      { id: 'a', name: 'bash', input: {} },
      { id: 'b', name: 'bash', input: {} },
    ],
  },
  { role: 'tool', callId: 'a', name: 'bash', output: 'one', isError: false },
  { role: 'tool', callId: 'b', name: 'bash', output: 'two', isError: false },
];
reply = sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }]);
await anthropic.send({
  model: 'claude-haiku-4-5-20251001',
  system: '',
  turns: withResults,
  tools: [],
  maxTokens: 100,
  onDelta: () => {},
});
const messages = lastRequest.body.messages as Array<{ role: string; content: unknown[] }>;
check(
  'consecutive tool results merge into one user message',
  messages.filter((m) => m.role === 'user').length === 2 &&
    messages[messages.length - 1].content.length === 2,
  JSON.stringify(messages.map((m) => m.role + ':' + m.content.length)),
);

server.close();
console.log(failures.length ? '\n' + failures.length + ' FAILED' : '\nAll provider checks passed');
process.exit(failures.length ? 1 : 0);
