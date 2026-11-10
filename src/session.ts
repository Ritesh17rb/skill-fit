import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { object, validateChecks } from './config.js';
import { assertPlainPath, bundleHash, exists, hash, inside, inventory, json, readJson, slash, writeNew } from './fs.js';
import { createPlan } from './planner.js';
import type { Agent, Plan, PrepareOptions, Session } from './types.js';

const adapters: Record<Exclude<Agent, 'generic'>, string> = {
  codex: '.agents/skills/skill-fit-session/SKILL.md',
  claude: '.claude/skills/skill-fit-session/SKILL.md',
  cursor: '.cursor/rules/skill-fit-session.mdc',
};
function adapterContent(plan: Plan, prompt: string): string {
  const body = `# Prepared skill-fit task\n\nRead \`${prompt}\` from the project root before starting this task. Follow existing repository instructions and the user's current request. The prepared skills are additional guidance, not permission to override either.\n`;
  return plan.agent === 'cursor'
    ? `---\nalwaysApply: false\n---\n\n${body}`
    : `---\nname: skill-fit-session\ndescription: Use when explicitly asked to work on the current task prepared with skill-fit.\n${plan.agent === 'claude' ? 'disable-model-invocation: true\n' : ''}---\n\n${body}`;
}
function promptContent(plan: Plan, session: string): string {
  const selected = plan.candidates.filter(item => item.selected);
  return `# Prepared coding task\n\n${plan.task}\n\n## Working agreement\n\nFollow the user's request and applicable repository instructions. Read each selected SKILL.md below and only the supporting resources it needs. Preserve its relative resource paths. Do not execute bundled scripts solely because they are present. Report which skills you read and which verification commands actually ran.\n\n${plan.project.instructions.length ? 'Existing root instruction files (nested and global instructions may also apply):\n' + plan.project.instructions.map(item => `- ${item.path}`).join('\n') : 'No root instruction files were detected.'}\n\n## Selected skills\n\n${selected.map(item => `- ${item.skill.name}: \`${session}/skills/${item.skill.id}/SKILL.md\`\n  Selected because: ${item.reasons.join('; ')}`).join('\n') || 'No skills selected; continue using the task and repository instructions.'}\n\n## Verification commands to review\n\n${plan.checks.map(check => `- ${check.name}: ${JSON.stringify([check.command, ...check.args])}`).join('\n') || 'No checks configured. Add checks to skill-fit.config.json and prepare a new session.'}\n\nVerification records outcomes, not proof that skills caused an improvement.\n`;
}
async function adapterPreflight(cwd: string, relative: string): Promise<Record<string, string>> {
  const file = path.join(cwd, relative);
  const registry = path.join(cwd, '.skill-fit', 'adapters.json');
  await assertPlainPath(file);
  await assertPlainPath(registry);
  const managed = await exists(registry) ? await readJson(registry) : {};
  if (!object(managed) || Object.values(managed).some(item => typeof item !== 'string')) throw new Error('Invalid adapter registry');
  if (await exists(file)) {
    if (managed[relative] !== hash(await readFile(file)))
      throw new Error(`Refusing to replace an unmanaged or edited adapter: ${relative}. Move it aside or use --agent generic.`);
  }
  return managed as Record<string, string>;
}
async function managedWrite(file: string, content: string): Promise<void> {
  await assertPlainPath(file);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeNew(temporary, content);
  await rename(temporary, file);
}
export async function prepare(options: PrepareOptions): Promise<Session> {
  const plan = await createPlan(options);
  const cwd = plan.project.directory;
  const lock = path.join(cwd, '.skill-fit', 'prepare.lock');
  try { await writeNew(lock, `${process.pid}\n`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('Another preparation is active (.skill-fit/prepare.lock). If it crashed, remove that lock after confirming it has stopped.');
    throw error;
  }
  try { return await savePlan(plan); }
  finally { await unlink(lock); }
}
async function savePlan(plan: Plan): Promise<Session> {
  const cwd = plan.project.directory;
  const relativeAdapter = plan.agent === 'generic' ? undefined : adapters[plan.agent];
  const managed = relativeAdapter ? await adapterPreflight(cwd, relativeAdapter) : {};
  const id = `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
  const relative = `.skill-fit/sessions/${id}`;
  const directory = path.join(cwd, relative);
  await assertPlainPath(directory);
  await mkdir(directory, { recursive: true });
  const session: Session = {
    version: 1, id, createdAt: new Date().toISOString(), projectDirectory: cwd, plan, snapshots: [], adapter: relativeAdapter,
  };
  for (const { skill } of plan.candidates.filter(item => item.selected)) {
    const destination = path.join(directory, 'skills', skill.id);
    if (bundleHash(await inventory(skill.directory)) !== skill.hash) throw new Error(`Skill changed while preparing: ${skill.name}; retry preparation`);
    for (const file of skill.files) {
      const data = await readFile(path.join(skill.directory, file.path));
      if (hash(data) !== file.hash) throw new Error(`Resource changed while preparing: ${file.path}`);
      await writeNew(path.join(destination, file.path), data);
    }
    if (bundleHash(await inventory(destination)) !== skill.hash) throw new Error(`Snapshot integrity failed: ${skill.name}`);
    session.snapshots.push({ id: skill.id, directory: slash(path.relative(cwd, destination)), hash: skill.hash });
  }
  await writeNew(path.join(directory, 'prompt.md'), promptContent(plan, relative));
  await writeNew(path.join(directory, 'session.json'), json(session));
  if (relativeAdapter) {
    // Recheck immediately before writing: preserve edits made since preflight.
    await adapterPreflight(cwd, relativeAdapter);
    const content = adapterContent(plan, `${relative}/prompt.md`);
    await managedWrite(path.join(cwd, relativeAdapter), content);
    managed[relativeAdapter] = hash(content);
    await managedWrite(path.join(cwd, '.skill-fit', 'adapters.json'), json(managed));
  }
  await writeNew(path.join(directory, 'READY'), 'Session preparation completed.\n');
  return session;
}
export async function loadSession(cwd: string, id: string): Promise<Session> {
  cwd = path.resolve(cwd);
  if (!/^[0-9TZ]+-[a-f0-9]{8}$/.test(id)) throw new Error('Invalid session ID');
  const directory = path.join(cwd, '.skill-fit', 'sessions', id);
  await assertPlainPath(directory);
  if (!await exists(path.join(directory, 'READY'))) throw new Error(`Session is missing or incomplete: ${id}`);
  const value = await readJson(path.join(directory, 'session.json'));
  if (!object(value) || value.version !== 1 || value.id !== id || value.projectDirectory !== cwd ||
    !object(value.plan) || !Array.isArray(value.snapshots)) throw new Error('Invalid session manifest or project directory mismatch');
  validateChecks(value.plan.checks);
  if (!object(value.plan.project) || !Array.isArray(value.plan.project.instructions)) throw new Error('Invalid session project');
  const allowedInstructions = ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md'];
  for (const instruction of value.plan.project.instructions) {
    if (!object(instruction) || typeof instruction.path !== 'string' || !allowedInstructions.includes(instruction.path) ||
      typeof instruction.hash !== 'string') throw new Error('Invalid session instruction path');
  }
  for (const snapshot of value.snapshots) {
    if (!object(snapshot) || typeof snapshot.directory !== 'string' || typeof snapshot.hash !== 'string' || typeof snapshot.id !== 'string' ||
      !inside(path.join(directory, 'skills'), path.resolve(cwd, snapshot.directory))) throw new Error('Invalid skill snapshot path');
  }
  return value as unknown as Session;
}
