import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepare, loadSession, verify } from '../dist/index.js';
import { fixture, config, skill } from './helpers.mjs';

test('preparation copies supporting resources and preserves existing repository instructions', async t => {
  const cwd = await fixture(t);
  await config(cwd);
  const directory = await skill(cwd, 'webhook');
  await mkdir(path.join(directory, 'references'));
  await writeFile(path.join(directory, 'references', 'guide.md'), 'Keep retry handling atomic.');
  await writeFile(path.join(cwd, 'AGENTS.md'), 'Preserve me.');
  const session = await prepare({ cwd, task: 'Fix webhook', agent: 'codex' });
  assert.equal(await readFile(path.join(cwd, 'AGENTS.md'), 'utf8'), 'Preserve me.');
  assert.equal(await readFile(path.join(cwd, session.snapshots[0].directory, 'references', 'guide.md'), 'utf8'), 'Keep retry handling atomic.');
  assert.match(await readFile(path.join(cwd, session.adapter), 'utf8'), new RegExp(session.id));
  const loaded = await loadSession(cwd, session.id);
  assert.equal(loaded.snapshots[0].hash, session.snapshots[0].hash);
});

test('all adapters generate the expected entry point and generic writes no agent files', async t => {
  for (const [agent, expected] of [['codex', '.agents/skills/skill-fit-session/SKILL.md'], ['claude', '.claude/skills/skill-fit-session/SKILL.md'], ['cursor', '.cursor/rules/skill-fit-session.mdc'], ['generic', undefined]]) {
    const cwd = await fixture(t);
    await skill(cwd, 'webhook');
    const session = await prepare({ cwd, task: 'Fix webhook', agent });
    assert.equal(session.adapter, expected);
    if (expected) {
      const content = await readFile(path.join(cwd, expected), 'utf8');
      assert.match(content, /prompt\.md/);
      if (agent === 'cursor') assert.match(content, /alwaysApply: false/);
      if (agent === 'claude') assert.match(content, /disable-model-invocation: true/);
    } else assert.deepEqual((await readdir(cwd)).filter(name => ['.agents', '.claude', '.cursor'].includes(name)), []);
  }
});

test('managed adapters can update but unmanaged or edited adapters cannot be overwritten', async t => {
  const cwd = await fixture(t);
  await skill(cwd, 'webhook');
  const first = await prepare({ cwd, task: 'Fix webhook', agent: 'claude' });
  const second = await prepare({ cwd, task: 'Fix webhook retry', agent: 'claude' });
  assert.notEqual(first.id, second.id);
  await writeFile(path.join(cwd, second.adapter), 'Handwritten custom adapter.');
  await assert.rejects(prepare({ cwd, task: 'Fix webhook', agent: 'claude' }), /unmanaged or edited/);
  assert.equal(await readFile(path.join(cwd, second.adapter), 'utf8'), 'Handwritten custom adapter.');
  // A failure must release the preparation lock.
  await prepare({ cwd, task: 'Fix webhook', agent: 'generic' });
});

test('snapshot changes prevent command execution and unsafe session IDs are rejected', async t => {
  const cwd = await fixture(t);
  await skill(cwd, 'webhook');
  await config(cwd, [{ name: 'must not run', command: process.execPath, args: ['-e', "require('fs').writeFileSync('executed', 'yes')"] }]);
  const session = await prepare({ cwd, task: 'Fix webhook' });
  await writeFile(path.join(cwd, session.snapshots[0].directory, 'SKILL.md'), 'Altered');
  const result = await verify({ cwd, session: session.id, execute: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.length, 0);
  assert.equal(result.integrity[0].code, 'snapshot-changed');
  assert.ok(!(await readdir(cwd)).includes('executed'));
  await assert.rejects(loadSession(cwd, '../../escape'), /Invalid session ID/);
});

test('symlinked managed output directories cannot redirect writes outside the project', async t => {
  const cwd = await fixture(t);
  const other = await fixture(t);
  try { await symlink(other, path.join(cwd, '.skill-fit'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Symlink creation requires privileges'); return; } throw error; }
  await assert.rejects(prepare({ cwd, task: 'Fix webhook' }), /Symlink\/junction/);
  assert.deepEqual(await readdir(other), ['package.json']);
});

test('tampered manifest paths are rejected before reading or running commands', async t => {
  const cwd = await fixture(t);
  await skill(cwd, 'webhook');
  const session = await prepare({ cwd, task: 'Fix webhook' });
  const manifest = path.join(cwd, '.skill-fit', 'sessions', session.id, 'session.json');
  session.plan.project.instructions.push({ path: '../../outside.txt', hash: 'invalid' });
  await writeFile(manifest, JSON.stringify(session));
  await assert.rejects(loadSession(cwd, session.id), /Invalid session instruction path/);
});
