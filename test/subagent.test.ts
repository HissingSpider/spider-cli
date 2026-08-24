/** Delegation is bounded and definitions are enforced: a "read-only" agent
 *  that can still call write_file is not read-only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/loop.ts';
import { loadAgents } from '../src/agents.ts';
import type { Settings } from '../src/config.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-agents-'));
fs.mkdirSync(path.join(dir, '.spider', 'agents'), { recursive: true });
fs.writeFileSync(
  path.join(dir, '.spider', 'agents', 'reviewer.md'),
  `---
name: reviewer
description: Reads code and reports, never edits
tools: read_file, grep, glob
---
You review code. You do not change it.
`,
);

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

console.log('\ndefinitions');
const defs = loadAgents(dir);
const reviewer = defs.find((d) => d.name === 'reviewer');
check('a definition file is found', !!reviewer, JSON.stringify(defs.map((d) => d.name)));
check(
  'frontmatter description is read',
  reviewer?.description === 'Reads code and reports, never edits',
  reviewer?.description,
);
check(
  'the tool list is parsed',
  JSON.stringify(reviewer?.tools) === '["read_file","grep","glob"]',
  JSON.stringify(reviewer?.tools),
);
check(
  'the body becomes the prompt',
  Boolean(reviewer?.prompt.includes('You do not change it')),
  reviewer?.prompt,
);

console.log('\ndepth');
const root = new Agent(dir, settings, null, 'https://example.invalid/v1', 'unused');
check('the session agent is depth 0', root.depth === 0);
check('it can delegate', 'task' in root.tools);

const child = root.fork();
check('a child is depth 1', child.depth === 1, String(child.depth));
check('a child may still delegate', child.allowSubagents && 'task' in child.tools);

const grandchild = child.fork();
check('a grandchild is depth 2', grandchild.depth === 2, String(grandchild.depth));
check('a grandchild may NOT delegate further', !grandchild.allowSubagents);
check('and has no task tool', !('task' in grandchild.tools));

console.log('\nno child can exit the parent plan mode');
check('exit_plan_mode is not inherited', !('exit_plan_mode' in child.tools));

console.log('\nthe task tool advertises what is available');
const spec = root.tools.task.spec.description;
check('the definition is offered to the model', spec.includes('reviewer'), spec);

console.log('\nan unknown agent type is refused');
const bad = await root.tools.task.run(
  { description: 'x', prompt: 'y', agent_type: 'nonexistent' },
  dir,
);
check('it errors rather than silently using the default', bad.isError, bad.output);
check('and lists what is available', bad.output.includes('reviewer'), bad.output);

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
if (failures.length) {
  console.error(failures.length + ' failure(s): ' + failures.join(', '));
  process.exit(1);
}
console.log('All subagent checks passed.');
