import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateChecks } from './config.js';
import { assertPlainPath, bundleHash, hash, inventory, json, writeNew } from './fs.js';
import { findExecutable } from './project.js';
import { loadSession } from './session.js';
import type { Check, CheckResult, Verification } from './types.js';

async function resolveCommand(check: Check): Promise<{ command: string; args: string[] }> {
  // Windows .cmd shims need a shell. Invoke npm's JS entry point directly instead.
  if (check.command === 'npm') {
    const npm = await findExecutable('npm');
    const candidates = [
      ...(npm ? [path.join(path.dirname(npm), 'node_modules/npm/bin/npm-cli.js')] : []),
      path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    ];
    for (const file of candidates) {
      try { await readFile(file); return { command: process.execPath, args: [file, ...check.args] }; } catch { /* next */ }
    }
    if (process.platform === 'win32') throw new Error('Cannot locate npm-cli.js; configure a node command with an explicit script path');
  }
  if (process.platform === 'win32') {
    const executable = await findExecutable(check.command);
    if (executable && /\.(cmd|bat)$/i.test(executable)) throw new Error('Windows .cmd/.bat checks are unsupported; use node plus the tool entry point');
  }
  return { command: check.command, args: check.args };
}
async function terminate(pid: number | undefined, child: ReturnType<typeof spawn>): Promise<void> {
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.on('error', () => { child.kill(); resolve(); });
      killer.on('close', () => resolve());
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
async function runCheck(check: Check, cwd: string): Promise<CheckResult> {
  const started = Date.now();
  const base: CheckResult = { name: check.name, command: check.command, args: check.args, status: 'error', exitCode: null,
    durationMs: 0, stdout: '', stderr: '', outputTruncated: false };
  try {
    const invocation = await resolveCommand(check);
    return await new Promise<CheckResult>(resolve => {
      const child = spawn(invocation.command, invocation.args, { cwd, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let timedOut = false;
      const limit = 64 * 1024;
      const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
      const sizes = { stdout: 0, stderr: 0 };
      for (const stream of ['stdout', 'stderr'] as const) child[stream]?.on('data', (data: Buffer) => {
        const take = Math.max(0, limit - sizes[stream]);
        if (data.length > take) base.outputTruncated = true;
        if (take > 0) chunks[stream].push(data.subarray(0, take));
        sizes[stream] += Math.min(take, data.length);
      });
      const timer = setTimeout(() => { timedOut = true; void terminate(child.pid, child); }, check.timeoutMs ?? 120000);
      let finished = false;
      function finish(exitCode: number | null, error?: Error): void {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ ...base, exitCode, durationMs: Date.now() - started,
          stdout: Buffer.concat(chunks.stdout).toString('utf8'),
          stderr: Buffer.concat(chunks.stderr).toString('utf8') + (error ? error.message : ''),
          status: timedOut ? 'timed-out' : error ? 'error' : exitCode === 0 ? 'passed' : 'failed' });
      }
      child.on('error', error => finish(null, error));
      child.on('close', code => finish(code));
    });
  } catch (error) { return { ...base, durationMs: Date.now() - started, stderr: (error as Error).message }; }
}
export async function verify(options: { cwd: string; session: string; execute: true; stage?: 'baseline' | 'after' }): Promise<Verification> {
  if (options.execute !== true) throw new Error('Verification executes project commands; execute: true is required');
  if (!['baseline', 'after'].includes(options.stage ?? 'after')) throw new Error('Invalid verification stage');
  const cwd = path.resolve(options.cwd);
  const session = await loadSession(cwd, options.session);
  const checks = validateChecks(session.plan.checks);
  const result: Verification = { version: 1, session: session.id, verifiedAt: new Date().toISOString(), stage: options.stage ?? 'after',
    status: 'no-checks', skillUsage: 'unobserved', causalImprovement: 'not-measured', checks: [], integrity: [] };
  for (const snapshot of session.snapshots) {
    try {
      if (bundleHash(await inventory(path.join(cwd, snapshot.directory))) !== snapshot.hash)
        result.integrity.push({ code: 'snapshot-changed', message: `${snapshot.id}: prepared bundle has changed` });
    } catch (error) { result.integrity.push({ code: 'snapshot-unreadable', message: `${snapshot.id}: ${(error as Error).message}` }); }
  }
  for (const instruction of session.plan.project.instructions) {
    try {
      if (hash(await readFile(path.join(cwd, instruction.path))) !== instruction.hash)
        result.integrity.push({ code: 'instructions-changed', message: `Root instructions changed since preparation: ${instruction.path}` });
    } catch { result.integrity.push({ code: 'instructions-missing', message: `Root instructions missing: ${instruction.path}` }); }
  }
  // Fail closed on altered snapshots; project checks must not legitimize a different prepared bundle.
  if (!result.integrity.some(item => item.code.startsWith('snapshot-'))) {
    for (const check of checks) result.checks.push(await runCheck(check, cwd));
    result.status = !checks.length ? 'no-checks' : result.checks.every(check => check.status === 'passed') ? 'passed' : 'failed';
  } else result.status = 'failed';
  const reportFile = path.join(cwd, '.skill-fit', 'sessions', session.id, 'reports', `${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  await assertPlainPath(reportFile);
  await writeNew(reportFile, json(result));
  return result;
}
