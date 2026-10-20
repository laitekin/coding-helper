import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// coding-helper 自身目录（惰性计算，便于测试时替换 HOME）
export function helperDir(): string {
  return path.join(os.homedir(), '.coding-helper');
}

export function backupsRoot(): string {
  return path.join(helperDir(), 'backups');
}

// 读取文本文件，不存在时返回 undefined
export function readTextFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

// 用户配置文件解析失败时抛出，避免把损坏的文件当作空配置覆盖掉
export class ConfigParseError extends Error {
  constructor(public readonly file: string, cause: unknown) {
    super(`Cannot parse ${file}: ${cause instanceof Error ? cause.message : String(cause)}. Fix or move the file, then retry.`);
    this.name = 'ConfigParseError';
  }
}

// 严格读取 JSON 对象：文件不存在返回 {}，内容损坏抛出 ConfigParseError
export function readJsonObjectStrict(file: string): Record<string, unknown> {
  const content = readTextFile(file);
  if (content === undefined || !content.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new ConfigParseError(file, err);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigParseError(file, new Error('top-level value is not an object'));
  }
  return parsed as Record<string, unknown>;
}

// 预演模式：只记录将要发生的变更，不写盘、不备份
export interface PlannedChange {
  file: string;
  before: string | undefined;
  // undefined 表示文件将被删除
  after: string | undefined;
}

let plannedChanges: Map<string, PlannedChange> | null = null;

export function setDryRun(enabled: boolean): void {
  plannedChanges = enabled ? new Map() : null;
}

export function isDryRun(): boolean {
  return plannedChanges !== null;
}

export function getPlannedChanges(): PlannedChange[] {
  return plannedChanges ? [...plannedChanges.values()] : [];
}

function planChange(file: string, after: string | undefined): void {
  if (!plannedChanges) return;
  const resolved = path.resolve(file);
  const before = plannedChanges.get(resolved)?.before ?? readTextFile(resolved);
  plannedChanges.set(resolved, { file: resolved, before, after });
}

// 原子写入：同目录写临时文件后 rename，避免中途失败留下半个文件
export function atomicWriteFile(file: string, content: string, mode = 0o600): void {
  // 预演模式下 coding-helper 自身的状态文件也不写
  if (plannedChanges) return;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode });
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') fs.chmodSync(file, mode);
}

// Windows 上目标文件被占用时 rename 会短暂失败，重试几次
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 3 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      const until = Date.now() + 50 * (attempt + 1);
      while (Date.now() < until) { /* 短暂等待 */ }
    }
  }
}

interface BackupEntry {
  source: string;
  backup: string;
}

// 每次进程运行共用一个备份目录：~/.coding-helper/backups/<时间戳>/
let sessionDir: string | null = null;
const backedUp = new Map<string, string>();

function timestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function ensureSessionDir(): string {
  if (sessionDir) return sessionDir;
  const base = path.join(backupsRoot(), timestamp(new Date()));
  let dir = base;
  for (let i = 1; fs.existsSync(dir); i++) dir = `${base}-${i}`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  sessionDir = dir;
  return dir;
}

// 写入前备份原文件；同一次运行内同一文件只备份一次。文件不存在时返回 undefined
export function backupFile(file: string): string | undefined {
  if (plannedChanges) return undefined;
  const resolved = path.resolve(file);
  const existing = backedUp.get(resolved);
  if (existing) return existing;
  if (!fs.existsSync(resolved)) return undefined;

  const dir = ensureSessionDir();
  const relative = path.relative(os.homedir(), resolved);
  const name = (relative.startsWith('..') ? resolved : relative).replace(/[\\/:]+/g, '__');
  const target = path.join(dir, name);
  fs.copyFileSync(resolved, target);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  backedUp.set(resolved, target);

  const manifestFile = path.join(dir, 'manifest.json');
  const entries: BackupEntry[] = [...backedUp.entries()]
    .filter(([, backup]) => path.dirname(backup) === dir)
    .map(([source, backup]) => ({ source, backup }));
  fs.writeFileSync(manifestFile, JSON.stringify({ files: entries }, null, 2) + '\n', { mode: 0o600 });
  return target;
}

// 本次运行中产生的备份（用于在结果页提示）
export function getSessionBackups(): BackupEntry[] {
  return [...backedUp.entries()].map(([source, backup]) => ({ source, backup }));
}

// 备份后原子写入
export function safeWriteFile(file: string, content: string, mode = 0o600): void {
  const current = readTextFile(file);
  if (current === content) return;
  // 文件原本不存在且没有内容要写：不凭空创建空文件
  if (current === undefined && !content.trim()) return;
  if (plannedChanges) {
    planChange(file, content);
    return;
  }
  backupFile(file);
  atomicWriteFile(file, content, mode);
}

// 按原文件的风格序列化 JSON：单行保持单行，缩进沿用原文件，末尾换行与原文件一致
export function formatJsonLike(original: string | undefined, data: unknown): string {
  if (original === undefined || !original.trim()) return JSON.stringify(data, null, 2) + '\n';
  const trailing = original.endsWith('\n') ? '\n' : '';
  if (!original.trim().includes('\n')) return JSON.stringify(data) + trailing;
  const indent = original.split('\n').find((line) => /^\s+\S/.test(line))?.match(/^\s+/)?.[0] ?? '  ';
  return JSON.stringify(data, null, indent) + trailing;
}

// 写入 JSON，保持原文件风格
export function writeJson(file: string, data: unknown): void {
  safeWriteFile(file, formatJsonLike(readTextFile(file), data));
}

// 写回 JSON 对象；还原后为空对象时删除文件（文件本就是我们创建的，或原本为空）
export function writeJsonOrRemove(file: string, data: Record<string, unknown>): void {
  if (Object.keys(data).length > 0) {
    writeJson(file, data);
    return;
  }
  if (fs.existsSync(file)) {
    if (plannedChanges) {
      planChange(file, undefined);
      return;
    }
    backupFile(file);
    fs.rmSync(file, { force: true });
  }
}

// 写回文本；还原后为空时删除文件
export function writeTextOrRemove(file: string, content: string): void {
  if (content.trim()) {
    safeWriteFile(file, content);
    return;
  }
  if (fs.existsSync(file)) {
    if (plannedChanges) {
      planChange(file, undefined);
      return;
    }
    backupFile(file);
    fs.rmSync(file, { force: true });
  }
}
