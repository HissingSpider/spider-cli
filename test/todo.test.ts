/** The todo tool. It only records intent, so it must never prompt and must be
 *  usable while planning — and it must refuse a list that claims two things
 *  are in progress at once. */
import { todoTool } from '../src/tools/todo.ts';
import { getTodos, clearTodos } from '../src/tools/todo.ts';
import { decide } from '../src/agent/permissions.ts';
import type { Settings } from '../src/config.ts';
import type { ToolCall } from '../src/providers/types.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

const base: Settings = {
  model: 'gpt-5', permissionMode: 'default', allow: [], deny: [], maxTokens: 8192,
  autoCompactAt: 100000, keepRecentTurns: 6, mcpServers: {},
  hooks: {},
};
const call = (todos: unknown): ToolCall => ({ id: 't', name: 'todo_write', input: { todos } });

clearTodos();

const ok = await todoTool.run(
  { todos: [{ content: 'read the code', status: 'in_progress' }, { content: 'fix it', status: 'pending' }] },
  '/tmp',
);
check('a valid list is accepted', !ok.isError, ok.output);
check('the list is readable by the UI', getTodos().length === 2);
check('status round-trips', getTodos()[0].status === 'in_progress');

const two = await todoTool.run(
  { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] },
  '/tmp',
);
check('two in_progress items are refused', two.isError, two.output);
check('a refused write does not clobber the previous list', getTodos().length === 2);

const bad = await todoTool.run({ todos: [{ content: 'a', status: 'nope' }] }, '/tmp');
check('an unknown status is refused', bad.isError, bad.output);

const empty = await todoTool.run({ todos: [{ content: '  ', status: 'pending' }] }, '/tmp');
check('an empty task is refused', empty.isError, empty.output);

const notArray = await todoTool.run({ todos: 'nope' }, '/tmp');
check('a non-array is refused', notArray.isError, notArray.output);

console.log('');
check('todo_write never prompts',
  decide(call([]), base, 'default', '/tmp').kind === 'allow');
check('todo_write works while planning',
  decide(call([]), base, 'plan', '/tmp').kind === 'allow');

clearTodos();
check('clearing works', getTodos().length === 0);

console.log('');
if (failures.length) {
  console.error(failures.length + ' failure(s): ' + failures.join(', '));
  process.exit(1);
}
console.log('All todo checks passed.');
