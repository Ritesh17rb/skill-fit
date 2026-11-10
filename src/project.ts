import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import { object } from './config.js';
import { exists, hash, readJson } from './fs.js';
import { readFile } from 'node:fs/promises';
import type { Project } from './types.js';

export async function inspectProject(cwd: string): Promise<Project> {
  const project: Project = { directory: path.resolve(cwd), name: path.basename(cwd), dependencies: {}, scripts: {}, instructions: [] };
  if (await exists(path.join(cwd, 'package.json'))) {
    const pkg = await readJson(path.join(cwd, 'package.json'));
    if (!object(pkg)) throw new Error('package.json must be an object');
    if (typeof pkg.name === 'string') project.name = pkg.name;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (object(pkg[field])) for (const [name, range] of Object.entries(pkg[field]))
        if (typeof range === 'string') project.dependencies[name] = range;
    }
    if (object(pkg.scripts)) for (const [name, command] of Object.entries(pkg.scripts))
      if (typeof command === 'string') project.scripts[name] = command;
  }
  for (const name of ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md']) {
    const file = path.join(cwd, name);
    if (await exists(file)) project.instructions.push({ path: name, hash: hash(await readFile(file)) });
  }
  return project;
}
export async function findExecutable(command: string): Promise<string | undefined> {
  if (!command || /[\0\r\n]/.test(command)) return undefined;
  const dirs = command.includes('/') || command.includes('\\') ? [''] : (process.env.PATH ?? '').split(path.delimiter);
  const extensions = process.platform === 'win32' && !path.extname(command) ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const directory of dirs) for (const ext of extensions) {
    const file = path.resolve(directory, command + ext);
    try {
      await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch { /* try next */ }
  }
  return undefined;
}
