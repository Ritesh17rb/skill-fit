import path from 'node:path';
import { exists, readJson, writeNew, json } from './fs.js';
import type { Check, Config } from './types.js';

export const defaultConfig: Config = {
  version: 1,
  skillRoots: ['.agents/skills', '.claude/skills', '.cursor/skills', 'skills'],
  maxSkills: 3,
  maxTokens: 8000,
  checks: [],
};
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim() || item.includes('\0')))
    throw new Error(`${field} must be an array of non-empty strings`);
  return value;
}
export function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > maximum)
    throw new Error(`${field} must be an integer from 1 to ${maximum}`);
  return value;
}
export function validateChecks(value: unknown): Check[] {
  if (!Array.isArray(value)) throw new Error('checks must be an array');
  return value.map((check, index) => {
    if (!object(check) || typeof check.name !== 'string' || !check.name.trim() ||
      typeof check.command !== 'string' || !check.command.trim() || check.command.includes('\0'))
      throw new Error(`Invalid check at index ${index}`);
    if (!Array.isArray(check.args) || check.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))
      throw new Error(`checks[${index}].args must be an array of strings without null bytes`);
    const args = check.args as string[];
    const timeoutMs = check.timeoutMs === undefined ? 120000 : positiveInteger(check.timeoutMs, 'timeoutMs', 3_600_000);
    return { name: check.name, command: check.command, args, timeoutMs };
  });
}
export async function loadConfig(cwd: string): Promise<Config> {
  const file = path.join(cwd, 'skill-fit.config.json');
  if (!await exists(file)) return structuredClone(defaultConfig);
  const value = await readJson(file);
  if (!object(value) || value.version !== 1) throw new Error('skill-fit.config.json requires version: 1');
  return {
    version: 1,
    skillRoots: value.skillRoots === undefined ? [...defaultConfig.skillRoots] : stringList(value.skillRoots, 'skillRoots'),
    maxSkills: positiveInteger(value.maxSkills ?? defaultConfig.maxSkills, 'maxSkills', 50),
    maxTokens: positiveInteger(value.maxTokens ?? defaultConfig.maxTokens, 'maxTokens', 1_000_000),
    checks: validateChecks(value.checks ?? []),
  };
}
export async function init(cwd: string): Promise<string> {
  const file = path.join(cwd, 'skill-fit.config.json');
  const config = structuredClone(defaultConfig);
  const packageFile = path.join(cwd, 'package.json');
  if (await exists(packageFile)) {
    const pkg = await readJson(packageFile);
    if (object(pkg) && object(pkg.scripts)) {
      for (const name of ['test', 'typecheck', 'lint']) {
        if (typeof pkg.scripts[name] === 'string') config.checks.push({ name, command: 'npm', args: ['run', name], timeoutMs: 120000 });
      }
    }
  }
  await writeNew(file, json(config));
  return file;
}
