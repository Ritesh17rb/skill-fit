import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run with npm run smoke');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'skill-fit-pack-'));
try {
  const { stdout } = await exec(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: root });
  const [packed] = JSON.parse(stdout);
  assert.ok(packed.files.length > 10);
  assert.ok(packed.files.every(file => !file.path.includes('.skill-fit/') && !file.path.startsWith('node_modules/') && !file.path.startsWith('test/')),
    'Published archive must exclude sessions, dependencies, and local tests');
  const installed = path.join(temporary, 'consumer');
  await exec(process.execPath, [npmCli, 'install', '--prefix', installed, path.join(temporary, packed.filename), '--ignore-scripts', '--no-audit', '--no-fund']);
  const packageRoot = path.join(installed, 'node_modules', '@ritesh17rb', 'skill-fit');
  const cli = path.join(packageRoot, 'dist', 'cli.js');
  await access(path.join(installed, 'node_modules', '.bin', process.platform === 'win32' ? 'skill-fit.cmd' : 'skill-fit'));
  const version = await exec(process.execPath, [cli, '--version']);
  assert.equal(version.stdout.trim(), '0.1.0');
  const plan = await exec(process.execPath, [cli, 'plan', '--cwd', path.join(packageRoot, 'examples', 'project'), '--task', 'Fix duplicate webhook payments on retry', '--json']);
  assert.equal(JSON.parse(plan.stdout).candidates.filter(item => item.selected).length, 2);
  await writeFile(path.join(installed, 'api.mjs'), `import { createPlan, prepare, verify } from '@ritesh17rb/skill-fit';\nif (![createPlan, prepare, verify].every(value => typeof value === 'function')) process.exit(1);\n`);
  await exec(process.execPath, ['api.mjs'], { cwd: installed });
  console.log(`Archive smoke test passed: ${packed.entryCount} files, ${packed.size} bytes. Installed CLI, bundled example, and library exports work.`);
} finally {
  // Only remove the exact temporary directory created for this smoke test.
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('skill-fit-pack-'));
  await rm(temporary, { recursive: true, force: true });
}
