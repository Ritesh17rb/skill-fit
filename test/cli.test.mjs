import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fixture, config, skill } from './helpers.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function run(cwd, ...args) {
  try { const result = await exec(process.execPath, [cli, '--cwd', cwd, ...args]); return { ...result, code: 0 }; }
  catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
}

test('help, version, invalid arguments, and JSON errors have useful exit behavior', async t => {
  const cwd = await fixture(t);
  assert.match((await run(cwd, '--help')).stdout, /skill-fit/);
  assert.equal((await run(cwd, '--version')).stdout.trim(), '0.1.0');
  const invalid = await run(cwd, 'plan', '--json');
  assert.equal(invalid.code, 1);
  assert.match(JSON.parse(invalid.stderr).error, /--task/);
  assert.equal((await run(cwd, 'nonsense')).code, 1);
  assert.equal((await run(cwd, 'plan', '--task', 'Fix bug', '--agent', 'unknown')).code, 1);
});

test('scan and plan are read-only; prepare, preview, verify, and report complete the flow', async t => {
  const cwd = await fixture(t);
  await skill(cwd, 'webhook');
  await config(cwd, [{ name: 'pass', command: process.execPath, args: ['-e', 'process.exit(0)'] }]);
  const scan = await run(cwd, 'scan', '--json');
  assert.equal(JSON.parse(scan.stdout).candidates.length, 1);
  const plan = await run(cwd, 'plan', '--task', 'Fix webhook', '--json');
  assert.equal(JSON.parse(plan.stdout).candidates[0].selected, true);
  assert.ok(!(await readdir(cwd)).includes('.skill-fit'));
  const prepared = await run(cwd, 'prepare', '--task', 'Fix webhook', '--agent', 'cursor', '--json');
  assert.equal(prepared.code, 0, prepared.stderr);
  const id = JSON.parse(prepared.stdout).id;
  const preview = await run(cwd, 'verify', '--session', id, '--json');
  assert.equal(JSON.parse(preview.stdout).execute, false);
  const verified = await run(cwd, 'verify', '--session', id, '--run', '--stage', 'baseline', '--json');
  assert.equal(verified.code, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).status, 'passed');
  const report = await run(cwd, 'report', '--session', id, '--json');
  assert.equal(JSON.parse(report.stdout).runs.length, 1);
  assert.equal(JSON.parse(report.stdout).baseline, 'passed');
});

test('failing and unconfigured checks return non-success exit codes', async t => {
  const cwd = await fixture(t);
  await config(cwd, [{ name: 'fail', command: process.execPath, args: ['-e', 'process.exit(3)'] }]);
  let session = JSON.parse((await run(cwd, 'prepare', '--task', 'Fix bug', '--json')).stdout);
  let result = await run(cwd, 'verify', '--session', session.id, '--run', '--json');
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).checks[0].exitCode, 3);
  await config(cwd);
  session = JSON.parse((await run(cwd, 'prepare', '--task', 'Fix bug', '--json')).stdout);
  result = await run(cwd, 'verify', '--session', session.id, '--run', '--json');
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).status, 'no-checks');
});
