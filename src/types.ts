export type Agent = 'generic' | 'codex' | 'claude' | 'cursor';
export type Profile = 'auto' | 'bugfix' | 'feature' | 'refactor';
export interface Check { name: string; command: string; args: string[]; timeoutMs?: number }
export interface Config {
  version: 1;
  skillRoots: string[];
  maxSkills: number;
  maxTokens: number;
  checks: Check[];
}
export interface SkillHints {
  tags: string[];
  profiles: string[];
  dependencies: Record<string, string>;
  commands: string[];
  rules: Record<string, string>;
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  directory: string;
  body: string;
  hash: string;
  files: { path: string; hash: string; bytes: number }[];
  estimatedTokens: number;
  hints: SkillHints;
  compatibility?: string;
}
export interface Finding { code: string; message: string; skills?: string[] }
export interface Project {
  directory: string;
  name: string;
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
  instructions: { path: string; hash: string }[];
}
export interface Candidate {
  skill: Skill;
  score: number;
  reasons: string[];
  blockers: string[];
  selected: boolean;
  excludedReason?: string;
}
export interface Plan {
  version: 1;
  task: string;
  agent: Agent;
  profile: Exclude<Profile, 'auto'>;
  project: Project;
  candidates: Candidate[];
  findings: Finding[];
  estimatedTokens: number;
  checks: Check[];
}
export interface PrepareOptions {
  cwd: string;
  task: string;
  agent?: Agent;
  profile?: Profile;
  roots?: string[];
  global?: boolean;
  include?: string[];
  exclude?: string[];
  maxSkills?: number;
  maxTokens?: number;
}
export interface Session {
  version: 1;
  id: string;
  createdAt: string;
  projectDirectory: string;
  plan: Plan;
  snapshots: { id: string; directory: string; hash: string }[];
  adapter?: string;
}
export interface CheckResult {
  name: string;
  command: string;
  args: string[];
  status: 'passed' | 'failed' | 'timed-out' | 'error';
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}
export interface Verification {
  version: 1;
  session: string;
  verifiedAt: string;
  stage: 'baseline' | 'after';
  status: 'passed' | 'failed' | 'no-checks';
  skillUsage: 'unobserved';
  causalImprovement: 'not-measured';
  checks: CheckResult[];
  integrity: Finding[];
}
