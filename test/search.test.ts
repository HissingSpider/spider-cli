/** web_search must fail loudly when unconfigured rather than looking like it
 *  works and returning nothing. */
import { createSearchTool } from '../src/tools/search.ts';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}

// The environment may or may not carry keys; this test is about the
// unconfigured path, so make sure it is genuinely unconfigured.
delete process.env.BRAVE_API_KEY;
delete process.env.TAVILY_API_KEY;

const unset = createSearchTool(undefined);
const result = await unset.run({ query: 'anything' }, process.cwd());
check('an unconfigured search is an error, not an empty result', result.isError, result.output);
check('the message says how to configure it',
  result.output.includes('BRAVE_API_KEY') || result.output.includes('settings.json'),
  result.output);
check('it tells the model what to do instead',
  result.output.includes('web_fetch'), result.output);
check('the tool description warns the model up front',
  unset.spec.description.includes('NOT CONFIGURED'), unset.spec.description);

const configured = createSearchTool({ provider: 'brave', apiKey: 'test-key' });
check('a configured tool describes itself normally',
  !configured.spec.description.includes('NOT CONFIGURED'), configured.spec.description);

const empty = await configured.run({ query: '   ' }, process.cwd());
check('an empty query is rejected before any network call',
  empty.isError && empty.output.includes('needs a query'), empty.output);

process.env.BRAVE_API_KEY = 'from-env';
const fromEnv = createSearchTool(undefined);
check('a key in the environment is picked up',
  !fromEnv.spec.description.includes('NOT CONFIGURED'));
delete process.env.BRAVE_API_KEY;

console.log('');
if (failures.length) {
  console.error(failures.length + ' failure(s): ' + failures.join(', '));
  process.exit(1);
}
console.log('All search checks passed.');
