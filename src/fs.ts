import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const slash = (value: string): string => value.split(path.sep).join('/');
export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
// Check every component so managed writes cannot traverse existing symlinks/junctions.
export async function assertPlainPath(file: string): Promise<void> {
  let current = path.parse(path.resolve(file)).root;
  for (const part of path.resolve(file).slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink/junction is not allowed here: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
export async function writeNew(file: string, content: string | Uint8Array): Promise<void> {
  await assertPlainPath(file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, { flag: 'wx' });
}
export async function readJson(file: string): Promise<unknown> {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}
export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
export interface BundleFile { path: string; hash: string; bytes: number }
const ignored = new Set(['.git', 'node_modules', '.skill-fit']);
export async function inventory(directory: string): Promise<BundleFile[]> {
  const files: BundleFile[] = [];
  let total = 0;
  await assertPlainPath(directory);
  async function visit(dir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`Skill bundle contains a symlink/junction: ${file}`);
      if (stat.isDirectory()) await visit(file);
      else if (stat.isFile()) {
        if (stat.size > 5_000_000 || total + stat.size > 20_000_000 || files.length >= 2000)
          throw new Error(`Skill bundle exceeds limits (5 MB/file, 20 MB/bundle, 2000 files): ${directory}`);
        const content = await readFile(file);
        total += content.length;
        files.push({ path: slash(path.relative(directory, file)), hash: hash(content), bytes: content.length });
      } else throw new Error(`Unsupported skill resource: ${file}`);
    }
  }
  await visit(directory);
  return files;
}
export const bundleHash = (files: BundleFile[]): string => hash(JSON.stringify(files));
