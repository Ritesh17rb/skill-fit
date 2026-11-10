import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { object, stringList } from './config.js';
import { bundleHash, exists, hash, inventory, readJson } from './fs.js';
import type { Finding, Skill, SkillHints } from './types.js';

function stringMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!object(value) || Object.entries(value).some(([key, item]) => !key.trim() || typeof item !== 'string' || !item.trim()))
    throw new Error(`${field} must map names to non-empty strings`);
  return value as Record<string, string>;
}
function hints(value: unknown): SkillHints {
  if (!object(value)) throw new Error('skill-fit hints must be an object');
  return {
    tags: stringList(value.tags ?? [], 'tags'),
    profiles: stringList(value.profiles ?? [], 'profiles'),
    dependencies: stringMap(value.dependencies, 'dependencies'),
    commands: stringList(value.commands ?? [], 'commands'),
    rules: stringMap(value.rules, 'rules'),
  };
}
export async function readSkill(directory: string): Promise<Skill> {
  directory = await realpath(directory);
  const files = await inventory(directory);
  const raw = (await readFile(path.join(directory, 'SKILL.md'), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(raw);
  if (!match) throw new Error('SKILL.md requires YAML frontmatter enclosed in ---');
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid YAML: ${document.errors[0]!.message}`);
  const metadata: unknown = document.toJS({ maxAliasCount: 20 });
  if (!object(metadata) || typeof metadata.name !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name) || metadata.name.length > 64)
    throw new Error('Skill name must be lowercase letters/numbers separated by hyphens (max 64 characters)');
  if (metadata.name === 'skill-fit-session') throw new Error('skill-fit-session is reserved for the generated adapter');
  if (typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 1024)
    throw new Error('Skill description must be non-empty and at most 1024 characters');
  if (!match[2]!.trim()) throw new Error('SKILL.md requires instructions after frontmatter');
  let extra: unknown = {};
  if (object(metadata.metadata) && typeof metadata.metadata['skill-fit'] === 'string')
    extra = JSON.parse(metadata.metadata['skill-fit']);
  if (await exists(path.join(directory, 'skill-fit.json'))) extra = await readJson(path.join(directory, 'skill-fit.json'));
  const digest = bundleHash(files);
  return {
    id: `${metadata.name}-${hash(directory).slice(0, 10)}`,
    name: metadata.name,
    description: metadata.description,
    directory,
    body: match[2]!.trim(),
    hash: digest,
    files,
    estimatedTokens: Math.ceil(raw.length / 4),
    hints: hints(extra),
    compatibility: typeof metadata.compatibility === 'string' ? metadata.compatibility : undefined,
  };
}
export async function discover(roots: string[]): Promise<{ skills: Skill[]; findings: Finding[] }> {
  const skills: Skill[] = [];
  const findings: Finding[] = [];
  const visited = new Set<string>();
  let directories = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 8 || ++directories > 10000) throw new Error('Skill discovery limit exceeded (8 levels / 10000 directories)');
    directory = await realpath(directory);
    if (visited.has(directory)) return;
    visited.add(directory);
    if (await exists(path.join(directory, 'SKILL.md'))) {
      if (path.basename(directory) === 'skill-fit-session') return;
      try { skills.push(await readSkill(directory)); }
      catch (error) { findings.push({ code: 'invalid-skill', message: `${directory}: ${(error as Error).message}` }); }
      return;
    }
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'scripts', 'references', 'assets'].includes(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && (await stat(child)).isDirectory())) await walk(child, depth + 1);
    }
  }
  for (const root of roots) {
    if (!await exists(root)) continue;
    try { await walk(root, 0); }
    catch (error) { findings.push({ code: 'discovery-error', message: `${root}: ${(error as Error).message}` }); }
  }
  return { skills, findings };
}
