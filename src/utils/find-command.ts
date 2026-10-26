import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

// 常见的全局安装目录：PATH 没带上它们时（如只在交互 shell 的配置里加了 PATH）也能找到
function commonDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.yarn', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

function isExecutable(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// 查找可执行文件：先查 PATH，再查常见安装目录与 extra（完整路径）。
// 不依赖 which：shell 别名（如 Claude Code 本地安装的 alias claude=~/.claude/local/claude）在子进程里看不到
export function findCommand(command: string, extra: string[] = []): string | undefined {
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())]
    : [''];
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), ...commonDirs()];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, command + ext);
      if (isExecutable(file)) return file;
    }
  }
  return extra.find(isExecutable);
}

// 运行「命令 --version」并取出语义化版本号
export function commandVersion(file: string): string | null {
  try {
    const output = execSync(`"${file}" --version`, { stdio: 'pipe', encoding: 'utf-8', timeout: 10000 }).trim();
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : output;
  } catch {
    return null;
  }
}
