import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepare, verify } from '../dist/index.js';
import { fixture, config } from './helpers.mjs';

test('records independent baseline and after checks without claiming causal improvement', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'check.mjs'), 'process.exit(1);');
  await config(cwd, [{ name: 'regression', command: process.execPath, args: ['check.mjs'] }]);
  const session = await prepare({ cwd, task: 'Fix duplicate webhook' });
  const baseline = await verify({ cwd, session: session.id, execute: true, stage: 'baseline' });
  assert.equal(baseline.status, 'failed');
  assert.equal(baseline.checks[0].exitCode, 1);
  await writeFile(path.join(cwd, 'check.mjs'), 'process.stdout.write("fixed");');
  const after = await verify({ cwd, session: session.id, execute: true, stage: 'after' });
  assert.equal(after.status, 'passed');
  assert.equal(after.checks[0].stdout, 'fixed');
  assert.equal(after.skillUsage, 'unobserved');
  assert.equal(after.causalImprovement, 'not-measured');
  const reports = await readdir(path.join(cwd, '.skill-fit', 'sessions', session.id, 'reports'));
  assert.equal(reports.length, 2);
});

test('verification has explicit no-checks status and requires execution opt-in', async t => {
  const cwd = await fixture(t);
  await config(cwd);
  const session = await prepare({ cwd, task: 'Build a feature' });
  const result = await verify({ cwd, session: session.id, execute: true });
  assert.equal(result.status, 'no-checks');
  await assert.rejects(verify({ cwd, session: session.id }), /execute: true/);
});

test('times out long-running checks, caps output, and records missing executables', async t => {
  const cwd = await fixture(t);
  await config(cwd, [
    { name: 'timeout', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 150 },
    { name: 'large output', command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(100000));'] },
    { name: 'missing', command: 'no-such-skill-fit-check-123456', args: [] },
  ]);
  const session = await prepare({ cwd, task: 'Fix a bug' });
  const result = await verify({ cwd, session: session.id, execute: true });
  assert.equal(result.checks[0].status, 'timed-out');
  assert.equal(result.checks[1].status, 'passed');
  assert.equal(Buffer.byteLength(result.checks[1].stdout), 65536);
  assert.equal(result.checks[1].outputTruncated, true);
  assert.equal(result.checks[2].status, 'error');
  assert.equal(result.status, 'failed');
});

test('verification arguments are passed literally without shell interpolation', async t => {
  const cwd = await fixture(t);
  const literal = 'hello & echo unexpected | $HOME; "quoted"';
  await config(cwd, [{ name: 'literal', command: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', literal] }]);
  const session = await prepare({ cwd, task: 'Build a feature' });
  const result = await verify({ cwd, session: session.id, execute: true });
  assert.equal(result.status, 'passed');
  assert.equal(result.checks[0].stdout, literal);
});

test('npm checks work through the real npm entry point on Windows and Unix', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'test.mjs'), 'console.log("npm check ran");');
  await config(cwd, [{ name: 'npm test', command: 'npm', args: ['run', 'test'] }]);
  const session = await prepare({ cwd, task: 'Fix a bug' });
  const result = await verify({ cwd, session: session.id, execute: true });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.match(result.checks[0].stdout, /npm check ran/);
});

test('verification continues to use the reviewed session checks after config changes', async t => {
  const cwd = await fixture(t);
  await config(cwd, [{ name: 'original', command: process.execPath, args: ['-e', 'console.log("original")'] }]);
  const session = await prepare({ cwd, task: 'Fix a bug' });
  await config(cwd, [{ name: 'replacement', command: process.execPath, args: ['-e', 'process.exit(1)'] }]);
  const result = await verify({ cwd, session: session.id, execute: true });
  assert.equal(result.checks[0].name, 'original');
  assert.equal(result.status, 'passed');
});
