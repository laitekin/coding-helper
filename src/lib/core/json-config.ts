import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// 只有文件不存在时按空对象处理；损坏或权限错误直接抛出，避免覆盖。
export function readJsonConfig(file: string): Record<string, unknown> {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object in ' + file);
  }
  return value as Record<string, unknown>;
}

// 沿用原文件的单行/多行、缩进、换行符和末尾换行。
function formatJson(original: string | undefined, value: Record<string, unknown>): string {
  if (original === undefined) return JSON.stringify(value, null, 2) + '\n';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const trailing = original.endsWith('\n') ? newline : '';
  if (!original.trim().includes('\n')) return JSON.stringify(value) + trailing;
  const indent = original.split(/\r?\n/).find(line => /^\s+\S/.test(line))?.match(/^\s+/)?.[0] ?? '  ';
  return JSON.stringify(value, null, indent).replace(/\n/g, newline) + trailing;
}

// 先备份再原子替换；失败时保留原文件并清理临时文件。符号链接写入其目标。
export function writeJsonConfig(file: string, value: Record<string, unknown>): void {
  readJsonConfig(file);
  let target = file;
  let original: string | undefined;
  try {
    fs.lstatSync(file);
    target = fs.realpathSync(file);
    original = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // 已存在但目标丢失的符号链接不能当作普通新文件替换。
    if (fs.lstatSync(file, { throwIfNoEntry: false })) throw error;
  }
  const content = formatJson(original, value);
  if (original === content) return;

  if (original !== undefined) {
    const backupDir = path.join(os.homedir(), '.coding-helper', 'backups');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backup = path.join(backupDir, path.basename(file) + '-' + randomUUID() + '.bak');
    fs.writeFileSync(backup, original, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }

  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, '.' + path.basename(target) + '.' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
