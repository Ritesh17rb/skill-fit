#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { init, positiveInteger } from './config.js';
import { assertPlainPath, exists, json, readJson } from './fs.js';
import { createPlan } from './planner.js';
import { loadSession, prepare } from './session.js';
import { verify } from './verify.js';
import type { Agent, Plan, PrepareOptions, Profile, Verification } from './types.js';

const help = `skill-fit — portable task preparation for coding agents

Usage:
  skill-fit init [--cwd PATH]
  skill-fit scan [--skills PATH] [--global] [--json]
  skill-fit plan --task TEXT [options]
  skill-fit prepare --task TEXT [--agent generic|codex|claude|cursor] [options]
  skill-fit verify --session ID [--stage baseline|after] [--run] [--json]
  skill-fit report --session ID [--json]

Options:
  --cwd PATH                 Project directory (default: current directory)
  --skills PATH              Skill directory or collection; repeatable, replaces configured roots
  --global                   Also discover skills in home agent directories
  --profile PROFILE          auto, bugfix, feature, refactor (default: auto)
  --include NAME_OR_ID        Require a skill; repeatable, fails if incompatible
  --exclude NAME_OR_ID        Exclude a skill; repeatable
  --max-skills N             Maximum selected skills (default: 3)
  --max-tokens N             Estimated SKILL.md token budget (default: 8000)
  --json                     Machine-readable output
  --run                      Execute the verification commands shown in the session
  --help                     Show this help
  --version                  Show package version

No agent/model is invoked. No network calls are made by planning or preparation.
verify previews commands unless --run is supplied. Project checks can access your machine.
`;
function displayPlan(plan: Plan): string {
  return [
    `Task: ${plan.task}`, `Profile: ${plan.profile} | Agent: ${plan.agent}`,
    `Selected ${plan.candidates.filter(item => item.selected).length} skills (~${plan.estimatedTokens} instruction tokens)`, '',
    ...plan.candidates.map(item => `${item.selected ? '[selected]' : '[skipped] '} ${item.skill.id}\n  ${item.selected ? item.reasons.join('; ') : item.excludedReason}`),
    '', ...plan.findings.map(finding => `[${finding.code}] ${finding.message}`),
    '', 'Token estimates use characters / 4; referenced resources and agent overhead are excluded.',
  ].join('\n');
}
function output(value: unknown, jsonOutput: boolean, text: string): void {
  process.stdout.write(jsonOutput ? json(value) : `${text}\n`);
}
async function reports(cwd: string, session: string): Promise<Verification[]> {
  const dir = path.join(cwd, '.skill-fit', 'sessions', session, 'reports');
  await assertPlainPath(dir);
  if (!await exists(dir)) return [];
  const records: Verification[] = [];
  for (const file of (await readdir(dir)).filter(file => file.endsWith('.json')).sort()) {
    await assertPlainPath(path.join(dir, file));
    records.push(await readJson(path.join(dir, file)) as Verification);
  }
  return records;
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, json: { type: 'boolean' },
    cwd: { type: 'string' }, task: { type: 'string' }, agent: { type: 'string' }, profile: { type: 'string' },
    skills: { type: 'string', multiple: true }, global: { type: 'boolean' },
    include: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
    'max-skills': { type: 'string' }, 'max-tokens': { type: 'string' },
    session: { type: 'string' }, run: { type: 'boolean' }, stage: { type: 'string' },
  } });
  if (values.version) { process.stdout.write('0.1.0\n'); return; }
  if (values.help || !positionals.length) { process.stdout.write(help); return; }
  if (positionals.length !== 1) throw new Error('Expected one command; run skill-fit --help');
  const command = positionals[0]!;
  const cwd = path.resolve(values.cwd ?? process.cwd());
  const jsonOutput = values.json ?? false;
  if (!['generic', 'codex', 'claude', 'cursor'].includes(values.agent ?? 'generic')) throw new Error('Invalid --agent');
  if (!['auto', 'bugfix', 'feature', 'refactor'].includes(values.profile ?? 'auto')) throw new Error('Invalid --profile');
  if (!['baseline', 'after'].includes(values.stage ?? 'after')) throw new Error('Invalid --stage');
  if (command === 'init') {
    const file = await init(cwd);
    output({ file }, jsonOutput, `Created ${file}\nReview skill roots and verification commands before preparing a task.`);
    return;
  }
  if (['scan', 'plan', 'prepare'].includes(command)) {
    if (command !== 'scan' && !values.task?.trim()) throw new Error('--task is required');
    const options: PrepareOptions = {
      cwd, task: values.task ?? 'Inspect available coding skills', agent: values.agent as Agent | undefined,
      profile: values.profile as Profile | undefined, roots: values.skills, global: values.global,
      include: values.include, exclude: values.exclude,
      maxSkills: values['max-skills'] === undefined ? undefined : positiveInteger(Number(values['max-skills']), 'max-skills', 50),
      maxTokens: values['max-tokens'] === undefined ? undefined : positiveInteger(Number(values['max-tokens']), 'max-tokens', 1_000_000),
    };
    if (command === 'prepare') {
      const session = await prepare(options);
      const invocation: Record<Agent, string> = {
        generic: `Ask your agent to read .skill-fit/sessions/${session.id}/prompt.md`,
        codex: 'In a new Codex session, invoke $skill-fit-session',
        claude: 'In a new Claude Code session, invoke /skill-fit-session',
        cursor: 'In Cursor, manually attach @skill-fit-session to your task',
      };
      output(session, jsonOutput, `${displayPlan(session.plan)}\n\nSession: ${session.id}\n${invocation[session.plan.agent]}\nPreview checks: skill-fit verify --session ${session.id}\nRun checks: skill-fit verify --session ${session.id} --run`);
    } else {
      const plan = await createPlan(options);
      output(plan, jsonOutput, command === 'scan'
        ? `${plan.candidates.map(item => `${item.skill.id}\n  ${item.skill.description}\n  ${item.skill.directory}`).join('\n')}\n${plan.findings.map(item => `[${item.code}] ${item.message}`).join('\n')}`
        : displayPlan(plan));
    }
    return;
  }
  if (command === 'verify' || command === 'report') {
    if (!values.session) throw new Error('--session is required');
    const session = await loadSession(cwd, values.session);
    if (command === 'verify') {
      if (!values.run) {
        output({ execute: false, checks: session.plan.checks }, jsonOutput,
          `Commands to execute in ${cwd}:\n${session.plan.checks.map(check => `  ${check.name}: ${JSON.stringify([check.command, ...check.args])}`).join('\n') || '  No checks configured.'}\nAdd --run to execute. Checks come from this prepared session, not subsequent config edits.`);
        return;
      }
      const result = await verify({ cwd, session: session.id, execute: true, stage: values.stage as 'baseline' | 'after' | undefined });
      output(result, jsonOutput, `Verification: ${result.status} (${result.stage})\n${result.checks.map(check => `  ${check.status}: ${check.name} (${check.durationMs}ms)${check.status !== 'passed' ? `\n${check.stderr || check.stdout}` : ''}`).join('\n')}\n${result.integrity.map(item => `[${item.code}] ${item.message}`).join('\n')}\nSkill usage: unobserved. Causal improvement: not measured.`);
      if (result.status !== 'passed') process.exitCode = result.status === 'no-checks' ? 2 : 1;
      return;
    }
    const runs = await reports(cwd, session.id);
    const baseline = runs.filter(run => run.stage === 'baseline').at(-1);
    const after = runs.filter(run => run.stage === 'after').at(-1);
    const report = { session, runs, baseline: baseline?.status ?? 'not-run', after: after?.status ?? 'not-run',
      skillUsage: 'unobserved', causalImprovement: 'not-measured' };
    output(report, jsonOutput, `Session: ${session.id}\nSelected skills: ${session.snapshots.length}\nVerification runs: ${runs.length}\nBaseline: ${report.baseline}\nAfter: ${report.after}\nSkill usage: unobserved\nCausal improvement: not measured\nA before/after check comparison does not isolate the effect of skills.`);
    return;
  }
  throw new Error(`Unknown command: ${command}. Run skill-fit --help`);
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes('--json')) process.stderr.write(json({ error: message }));
  else process.stderr.write(`skill-fit: ${message}\n`);
  process.exitCode = 1;
});
