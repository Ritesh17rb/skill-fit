import path from 'node:path';
import os from 'node:os';
import semver from 'semver';
import { loadConfig, positiveInteger } from './config.js';
import { discover } from './discovery.js';
import { hash } from './fs.js';
import { findExecutable, inspectProject } from './project.js';
import type { Candidate, Finding, Plan, PrepareOptions, Profile, Skill } from './types.js';

const stop = new Set('a an the and or of to for with in on at is it this that use using skill skills code coding project when how your you should from'.split(' '));
function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(word => word.length > 2 && !stop.has(word)));
}
function profileFor(task: string, profile: Profile): Exclude<Profile, 'auto'> {
  if (profile !== 'auto') return profile;
  if (/\b(refactor|simplify|cleanup|restructure)\b/i.test(task)) return 'refactor';
  return /\b(fix|bug|broken|regression|crash|duplicate|retry|retries)\b/i.test(task) ? 'bugfix' : 'feature';
}
function pairFindings(skills: Skill[]): Finding[] {
  const findings: Finding[] = [];
  for (let i = 0; i < skills.length; i++) for (let j = i + 1; j < skills.length; j++) {
    const a = skills[i]!, b = skills[j]!;
    if (a.hash === b.hash || hash(a.body) === hash(b.body))
      findings.push({ code: 'duplicate', skills: [a.id, b.id], message: `${a.name} and ${b.name} have identical bundles or instruction bodies` });
    else {
      const left = words(`${a.name} ${a.description}`), right = words(`${b.name} ${b.description}`);
      const intersection = [...left].filter(word => right.has(word)).length;
      if (intersection >= 4 && intersection / Math.max(1, new Set([...left, ...right]).size) >= 0.55)
        findings.push({ code: 'possible-overlap', skills: [a.id, b.id], message: `${a.name} and ${b.name} have similar descriptions; this is a lexical hint, not a semantic conflict verdict` });
    }
    for (const [key, value] of Object.entries(a.hints.rules)) {
      if (b.hints.rules[key] !== undefined && b.hints.rules[key] !== value)
        findings.push({ code: 'rule-conflict', skills: [a.id, b.id], message: `${key}: ${a.name} declares ${JSON.stringify(value)}, ${b.name} declares ${JSON.stringify(b.hints.rules[key])}` });
    }
  }
  return findings;
}
export async function createPlan(options: PrepareOptions): Promise<Plan> {
  const cwd = path.resolve(options.cwd);
  if (!options.task.trim()) throw new Error('A non-empty task is required');
  if (!['generic', 'codex', 'claude', 'cursor'].includes(options.agent ?? 'generic')) throw new Error('Invalid agent');
  if (!['auto', 'bugfix', 'feature', 'refactor'].includes(options.profile ?? 'auto')) throw new Error('Invalid profile');
  const config = await loadConfig(cwd);
  const maxSkills = positiveInteger(options.maxSkills ?? config.maxSkills, 'maxSkills', 50);
  const maxTokens = positiveInteger(options.maxTokens ?? config.maxTokens, 'maxTokens', 1_000_000);
  const roots = (options.roots ?? config.skillRoots).map(root => path.resolve(cwd, root));
  if (options.global) roots.push(...['.agents/skills', '.claude/skills', '.cursor/skills', '.codex/skills'].map(root => path.join(os.homedir(), root)));
  const { skills, findings } = await discover(roots);
  const project = await inspectProject(cwd);
  const profile = profileFor(options.task, options.profile ?? 'auto');
  const taskWords = words(options.task);
  const include = options.include ?? [], exclude = options.exclude ?? [];
  for (const selector of [...include, ...exclude]) {
    const matches = skills.filter(skill => skill.id === selector || skill.name === selector);
    if (!matches.length) throw new Error(`Unknown skill selector: ${selector}`);
    if (matches.length > 1) throw new Error(`Ambiguous skill name ${selector}; use the ID shown by scan`);
  }
  const matches = (list: string[], skill: Skill) => list.includes(skill.name) || list.includes(skill.id);
  const candidates: Candidate[] = [];
  for (const skill of skills) {
    let score = 0;
    const reasons: string[] = [], blockers: string[] = [];
    const strong = words(`${skill.name} ${skill.description} ${skill.hints.tags.join(' ')}`);
    const shared = [...taskWords].filter(word => strong.has(word));
    if (shared.length) { score += shared.length * 4; reasons.push(`Task terms: ${shared.join(', ')}`); }
    const bodyWords = words(skill.body);
    const bodyTerms = [...taskWords].filter(word => !strong.has(word) && bodyWords.has(word));
    if (bodyTerms.length) { score += Math.min(bodyTerms.length, 3); reasons.push(`Instruction terms: ${bodyTerms.join(', ')}`); }
    if (skill.hints.profiles.includes(profile)) { score += 5; reasons.push(`Declared ${profile} profile`); }
    for (const [dependency, required] of Object.entries(skill.hints.dependencies)) {
      const actual = project.dependencies[dependency];
      if (!semver.validRange(required)) { blockers.push(`Invalid required version range for ${dependency}: ${required}`); continue; }
      if (!actual) blockers.push(`Missing project dependency: ${dependency} (${required})`);
      else if (!semver.validRange(actual)) findings.push({ code: 'unknown-version', skills: [skill.id], message: `Cannot compare ${dependency} declaration ${actual} with ${required}` });
      else if (!semver.intersects(actual, required)) blockers.push(`Declared ${dependency} range ${actual} does not intersect ${required}`);
      else { score += 2; reasons.push(`Compatible declared dependency: ${dependency} ${actual}`); }
    }
    for (const command of skill.hints.commands) if (!await findExecutable(command)) blockers.push(`Missing executable on PATH: ${command}`);
    if (skill.compatibility) findings.push({ code: 'compatibility-note', skills: [skill.id], message: `${skill.name}: ${skill.compatibility} (free text; not automatically validated)` });
    if (matches(include, skill)) { score += 10000; reasons.push('Explicitly included'); }
    if (matches(include, skill) && matches(exclude, skill)) throw new Error(`${skill.name} is both included and excluded`);
    candidates.push({ skill, score, reasons, blockers, selected: false,
      excludedReason: matches(exclude, skill) ? 'Explicitly excluded' : undefined });
  }
  findings.push(...pairFindings(skills));
  candidates.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  const selected: Candidate[] = [];
  let estimatedTokens = 0;
  for (const candidate of candidates) {
    const { skill } = candidate;
    const conflict = findings.find(finding => ['duplicate', 'rule-conflict'].includes(finding.code) &&
      finding.skills?.includes(skill.id) && selected.some(item => finding.skills?.includes(item.skill.id)));
    if (!candidate.excludedReason) candidate.excludedReason = candidate.blockers.length ? candidate.blockers.join('; ') :
      candidate.score === 0 ? 'No matching task, profile, or dependency signals' :
      conflict ? `Excluded to avoid ${conflict.code} with a selected skill` :
      selected.length >= maxSkills ? `Skill limit (${maxSkills}) reached` :
      estimatedTokens + skill.estimatedTokens > maxTokens ? `Instruction token estimate exceeds budget (${maxTokens})` : undefined;
    if (candidate.excludedReason && matches(include, skill)) throw new Error(`Cannot include ${skill.id}: ${candidate.excludedReason}`);
    if (!candidate.excludedReason) { candidate.selected = true; selected.push(candidate); estimatedTokens += skill.estimatedTokens; }
  }
  if (!skills.length) findings.push({ code: 'no-skills', message: 'No valid skills found. Add a local skill root with --skills PATH, or opt in to home directories with --global.' });
  else if (!selected.length) findings.push({ code: 'no-selection', message: 'No skills selected. Check the exclusions, change the task, or explicitly --include a skill ID.' });
  return { version: 1, task: options.task, agent: options.agent ?? 'generic', profile, project, candidates, findings, estimatedTokens, checks: config.checks };
}
