import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'skill-fit-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'node test.mjs' } }));
  return cwd;
}
export async function config(cwd, checks = [], extra = {}) {
  await writeFile(path.join(cwd, 'skill-fit.config.json'), JSON.stringify({ version: 1, skillRoots: ['skills'], maxSkills: 3, maxTokens: 8000, checks, ...extra }));
}
export async function skill(cwd, name, options = {}) {
  const directory = path.join(cwd, 'skills', options.folder ?? name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), options.raw ?? `---\nname: ${name}\ndescription: ${options.description ?? 'Fix webhook bugs and duplicate payments with regression checks.'}\n---\n\n${options.body ?? 'Trace webhook retry behavior. Test duplicate event handling.'}\n`);
  if (options.hints) await writeFile(path.join(directory, 'skill-fit.json'), JSON.stringify(options.hints));
  return directory;
}
