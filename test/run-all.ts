/**
 * Test runner. Each suite is a standalone script that exits non-zero on
 * failure, so this just runs them in child processes and tallies the results —
 * no framework, and a suite can still be run on its own while debugging.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = import.meta.dirname;
const only = process.argv[2];

const suites = fs
  .readdirSync(dir)
  .filter((f) => /\.(test\.ts|smoke\.tsx)$/.test(f))
  .filter((f) => !only || f.includes(only))
  .sort();

if (!suites.length) {
  console.error(only ? 'No suites match "' + only + '"' : 'No suites found');
  process.exit(1);
}

const tsx = path.join(dir, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const failed: string[] = [];
const started = Date.now();

for (const suite of suites) {
  const name = suite.replace(/\.(test\.ts|smoke\.tsx)$/, '');
  process.stdout.write('  ' + name.padEnd(14));

  const res = spawnSync(process.execPath, [tsx, path.join(dir, suite)], {
    encoding: 'utf8',
    timeout: 300_000,
  });
  const out = (res.stdout ?? '') + (res.stderr ?? '');

  if (res.status === 0) {
    const passes = (out.match(/^\s*PASS/gm) ?? []).length;
    console.log('ok' + (passes ? '   ' + passes + ' checks' : ''));
  } else {
    failed.push(name);
    console.log('FAIL');
    // Only the failing suite's output is worth printing; the rest is noise.
    console.log(
      out
        .split('\n')
        .filter((l) => /FAIL|Error|error:/i.test(l))
        .slice(0, 12)
        .map((l) => '        ' + l)
        .join('\n'),
    );
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  '\n' + (failed.length ? failed.length + ' of ' + suites.length + ' suites FAILED: ' + failed.join(', ')
    : 'All ' + suites.length + ' suites passed') + '  (' + secs + 's)',
);
process.exit(failed.length ? 1 : 0);
