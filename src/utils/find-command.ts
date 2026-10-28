import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';

export function commandPathEntries(value: string, platform: NodeJS.Platform = process.platform): string[] {
  return value.split(platform === 'win32' ? ';' : ':').map(entry =>
    platform === 'win32' && entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry).filter(Boolean);
}

function executable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// 先 PATH，再常见全局目录和工具提供的完整路径；忽略空 PATH 项，避免意外执行工作目录文件
export function findCommand(command: string, extra: string[] = []): string | undefined {
  if (path.isAbsolute(command)) return executable(command) ? command : undefined;
  if (!/^[A-Za-z0-9_.-]+$/.test(command)) return undefined;
  const home = os.homedir();
  const common = ['.local/bin', '.npm-global/bin', '.bun/bin', '.volta/bin', '.yarn/bin'].map(dir => path.join(home, dir));
  if (process.platform === 'win32') {
    if (process.env.APPDATA) common.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) common.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
  } else common.push('/opt/homebrew/bin', '/usr/local/bin');
  const dirs = [...commandPathEntries(process.env.PATH ?? ''), ...common];
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
  for (const dir of dirs) for (const ext of exts) {
    const candidate = path.resolve(dir, command + ext);
    if (executable(candidate)) return candidate;
  }
  return extra.find(executable);
}

export function commandVersion(file: string): string | null {
  try {
    const result = spawn.sync(file, ['--version'], { stdio: 'pipe', encoding: 'utf8', timeout: 10000 });
    if (result.error || result.status !== 0) return null;
    const output = result.stdout.trim();
    return (output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? output) || null;
  } catch { return null; }
}
