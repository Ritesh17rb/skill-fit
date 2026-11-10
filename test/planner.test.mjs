import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPlan, discover, init } from '../dist/index.js';
import { fixture, config, skill } from './helpers.mjs';

test('selects task-relevant guidance, explains reasons, and blocks incompatible dependencies', async t => {
  const cwd = await fixture(t);
  await skill(cwd, 'webhook');
  await skill(cwd, 'react', { description: 'React frontend components', body: 'Build semantic interfaces.', hints: { dependencies: { react: '>=18' } } });
  const plan = await createPlan({ cwd, task: 'Fix duplicate webhook payments' });
  assert.deepEqual(plan.candidates.filter(c => c.selected).map(c => c.skill.name), ['webhook']);
  assert.ok(plan.candidates[0].reasons.some(r => r.includes('webhook')));
  assert.match(plan.candidates.find(c => c.skill.name === 'react').excludedReason, /Missing project dependency/);
  assert.equal(plan.profile, 'bugfix');
});

test('reads multiline YAML and explicit profile hints without requiring custom metadata', async t => {
  const cwd = await fixture(t);
  await skill(cwd, 'multiline', { raw: '---\nname: multiline\ndescription: >\n  Fix duplicate webhook\n  events and retry handling.\n---\nRead references/checklist.md.\n' });
  const plan = await createPlan({ cwd, task: 'Fix webhook retries' });
  assert.equal(plan.candidates[0].selected, true);
  assert.match(plan.candidates[0].skill.description, /events and retry/);
});

test('duplicate instructions and declared rule conflicts do not get co-selected', async t => {
  const cwd = await fixture(t);
  await skill(cwd, 'first', { hints: { rules: { runner: 'vitest' } } });
  await skill(cwd, 'copy');
  await skill(cwd, 'opposite', { body: 'Test webhook payments using jest.', hints: { rules: { runner: 'jest' } } });
  const plan = await createPlan({ cwd, task: 'Fix webhook', include: ['first'] });
  assert.equal(plan.candidates.filter(c => c.selected).length, 1);
  assert.ok(plan.findings.some(f => f.code === 'duplicate'));
  assert.ok(plan.findings.some(f => f.code === 'rule-conflict'));
  await assert.rejects(createPlan({ cwd, task: 'Fix webhook', include: ['first', 'opposite'] }), /Cannot include/);
});

test('explicit selections fail visibly for unknown, ambiguous, excluded, and over-budget skills', async t => {
  const cwd = await fixture(t);
  await skill(cwd, 'one');
  await assert.rejects(createPlan({ cwd, task: 'Fix webhook', include: ['missing'] }), /Unknown/);
  await assert.rejects(createPlan({ cwd, task: 'Fix webhook', include: ['one'], exclude: ['one'] }), /both included and excluded/);
  await assert.rejects(createPlan({ cwd, task: 'Fix webhook', include: ['one'], maxTokens: 1 }), /budget/);
  await skill(cwd, 'one', { folder: 'another' });
  await assert.rejects(createPlan({ cwd, task: 'Fix webhook', include: ['one'] }), /Ambiguous/);
});

test('semver declarations distinguish matching and mismatched dependencies', async t => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }));
  await skill(cwd, 'compatible', { body: 'Build components.', hints: { dependencies: { react: '>=18 <20' } } });
  await skill(cwd, 'old', { body: 'Build legacy components.', hints: { dependencies: { react: '^17' } } });
  const plan = await createPlan({ cwd, task: 'Build react UI' });
  assert.equal(plan.candidates.find(c => c.skill.name === 'compatible').selected, true);
  assert.match(plan.candidates.find(c => c.skill.name === 'old').excludedReason, /does not intersect/);
});

test('invalid skills and unavailable commands produce actionable diagnostics', async t => {
  const cwd = await fixture(t);
  await skill(cwd, 'bad', { raw: 'No frontmatter' });
  await skill(cwd, 'missing-tool', { hints: { commands: ['skill-fit-no-such-executable-123456'] } });
  const plan = await createPlan({ cwd, task: 'Fix webhook' });
  assert.equal(plan.candidates.length, 1);
  assert.match(plan.candidates[0].excludedReason, /Missing executable/);
  assert.ok(plan.findings.some(f => f.code === 'invalid-skill'));
});

test('resources are content-addressed and a resource change alters the bundle hash', async t => {
  const cwd = await fixture(t);
  const directory = await skill(cwd, 'resourceful');
  await mkdir(path.join(directory, 'references'));
  await writeFile(path.join(directory, 'references', 'guide.md'), 'Version one');
  const first = await discover([path.join(cwd, 'skills')]);
  await writeFile(path.join(directory, 'references', 'guide.md'), 'Version two');
  const second = await discover([path.join(cwd, 'skills')]);
  assert.notEqual(first.skills[0].hash, second.skills[0].hash);
});

test('init discovers project checks and never overwrites an existing config', async t => {
  const cwd = await fixture(t);
  await init(cwd);
  const parsed = JSON.parse(await readFile(path.join(cwd, 'skill-fit.config.json'), 'utf8'));
  assert.deepEqual(parsed.checks[0].args, ['run', 'test']);
  await assert.rejects(init(cwd), /EEXIST/);
});

test('skill directory links are canonicalized but resource links are rejected', async t => {
  const cwd = await fixture(t);
  const directory = await skill(cwd, 'linked');
  await mkdir(path.join(cwd, 'library'));
  try { await symlink(directory, path.join(cwd, 'library', 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Symlink creation requires privileges'); return; } throw error; }
  const found = await discover([path.join(cwd, 'library'), path.join(cwd, 'skills')]);
  assert.equal(found.skills.length, 1);
  await symlink(path.join(cwd, 'library'), path.join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const invalid = await discover([directory]);
  assert.equal(invalid.skills.length, 0);
  assert.match(invalid.findings[0].message, /symlink\/junction/);
});

test('budget limits and lack of matching signals result in explicit exclusions', async t => {
  const cwd = await fixture(t);
  await skill(cwd, 'one');
  let plan = await createPlan({ cwd, task: 'Fix webhook', maxTokens: 1 });
  assert.match(plan.candidates[0].excludedReason, /budget/);
  plan = await createPlan({ cwd, task: 'Translate poetry into French' });
  assert.equal(plan.candidates[0].selected, false);
  assert.ok(plan.findings.some(f => f.code === 'no-selection'));
});
