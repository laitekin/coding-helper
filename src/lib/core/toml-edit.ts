import { parse } from 'smol-toml';

// 按行编辑 TOML：只改动指定的键和表，保留注释、顺序和其他内容

export function isTomlTableHeader(line: string): boolean {
  return /^\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(line.trim());
}

// Parse equivalent quoted/dotted spellings into one canonical table path.
function canonicalTableName(name: string): string {
  let value: unknown = parse('[' + name + ']');
  const keys: string[] = [];
  while (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (!entries.length) break;
    if (entries.length !== 1) throw new Error('Invalid TOML table path.');
    const [key, child] = entries[0];
    keys.push(/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));
    value = child;
  }
  return keys.join('.');
}

// 表头中的表名，如 [models."qiniu/x"] → models."qiniu/x"
export function tomlTableName(line: string): string | undefined {
  const match = line.trim().match(/^\[\[?\s*(.+?)\s*\]\]?\s*(#.*)?$/);
  return match ? canonicalTableName(match[1]) : undefined;
}

// 顶层区域：第一个表头之前的行
export function topLevelEnd(lines: string[]): number {
  const index = lines.findIndex((line) => isTomlTableHeader(line));
  return index >= 0 ? index : lines.length;
}

function topLevelKeyPattern(key: string): RegExp {
  return new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
}

// 读取顶层键的原始值文本（如 '"gpt-5"'），不存在时返回 undefined
export function getTopLevelTomlValue(content: string, key: string): string | undefined {
  const lines = content.split('\n');
  const end = topLevelEnd(lines);
  const pattern = topLevelKeyPattern(key);
  for (let i = 0; i < end; i++) {
    const trimmed = lines[i].trim();
    if (pattern.test(trimmed)) return trimmed.replace(pattern, '').trim();
  }
  return undefined;
}

// 更新或插入顶层键；已存在时原地替换，新键插在顶层区域末尾（第一个表头之前）
function rawupsertTopLevelTomlKey(content: string, key: string, rawValue: string): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(newline);
  const end = topLevelEnd(lines);
  const pattern = topLevelKeyPattern(key);
  const line = `${key} = ${rawValue}`;
  const index = lines.findIndex((l, i) => i < end && pattern.test(l.trim()));
  if (index >= 0) {
    lines[index] = replaceValue(lines[index], rawValue);
    return lines.join(newline);
  }
  let insertAt = end;
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, line);
  // 紧挨着表头时补一个空行，保持可读
  if (insertAt + 1 < lines.length && isTomlTableHeader(lines[insertAt + 1])) {
    lines.splice(insertAt + 1, 0, '');
  }
  return lines.join(newline);
}

// 删除顶层键
function rawremoveTopLevelTomlKey(content: string, key: string): string {
  const lines = content.split('\n');
  const end = topLevelEnd(lines);
  const pattern = topLevelKeyPattern(key);
  return lines.filter((line, i) => i >= end || !pattern.test(line.trim())).join('\n');
}

// 删除表名满足条件的所有表（含其下的键）
function rawremoveTomlTablesWhere(content: string, match: (name: string) => boolean): string {
  const result: string[] = [];
  let skipping = false;
  for (const line of content.split('\n')) {
    if (isTomlTableHeader(line)) {
      const name = tomlTableName(line);
      skipping = !!name && match(name);
      if (skipping) continue;
    }
    if (!skipping) result.push(line);
  }
  return result.join('\n');
}

// 删除指定表及其子表（[name] 与 [name.xxx]）
export function removeTomlTable(content: string, tableName: string): string {
  tableName = canonicalTableName(tableName);
  return removeTomlTablesWhere(content, (name) => name === tableName || name.startsWith(`${tableName}.`));
}

export function escapeTomlString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export function normalizeToml(content: string): string {
  const trimmed = content.trim();
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  return trimmed ? `${trimmed}${newline}` : '';
}

// 表的行范围 [表头行, 下一个表头行)；不存在时返回 undefined
function tableRange(lines: string[], tableName: string): [number, number] | undefined {
  tableName = canonicalTableName(tableName);
  const start = lines.findIndex((line) => isTomlTableHeader(line) && tomlTableName(line) === tableName);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !isTomlTableHeader(lines[end])) end++;
  return [start, end];
}

// 读取 [table] 下某个键的原始值文本
export function getTomlTableValue(content: string, tableName: string, key: string): string | undefined {
  const lines = content.split('\n');
  const range = tableRange(lines, tableName);
  if (!range) return undefined;
  const pattern = topLevelKeyPattern(key);
  for (let i = range[0] + 1; i < range[1]; i++) {
    const trimmed = lines[i].trim();
    if (pattern.test(trimmed)) return trimmed.replace(pattern, '').trim();
  }
  return undefined;
}

// 设置 [table] 下的键；表不存在时追加到文件末尾
function rawupsertTomlTableKey(content: string, tableName: string, key: string, rawValue: string): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(newline);
  const line = `${key} = ${rawValue}`;
  const range = tableRange(lines, tableName);
  if (!range) {
    const body = content.trim();
    return `${body ? `${body}${newline}${newline}` : ''}[${tableName}]${newline}${line}${newline}`;
  }
  const pattern = topLevelKeyPattern(key);
  for (let i = range[0] + 1; i < range[1]; i++) {
    if (pattern.test(lines[i].trim())) {
      lines[i] = replaceValue(lines[i], rawValue);
      return lines.join(newline);
    }
  }
  let insertAt = range[1];
  while (insertAt > range[0] + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, line);
  return lines.join(newline);
}

// 删除 [table] 下的键；表因此变空时连表头一起删除
function rawremoveTomlTableKey(content: string, tableName: string, key: string): string {
  const lines = content.split('\n');
  const range = tableRange(lines, tableName);
  if (!range) return content;
  const pattern = topLevelKeyPattern(key);
  const kept = lines.filter((line, i) => i <= range[0] || i >= range[1] || !pattern.test(line.trim()));
  const after = tableRange(kept, tableName);
  if (after && kept.slice(after[0] + 1, after[1]).every((l) => !l.trim())) {
    kept.splice(after[0], after[1] - after[0]);
  }
  return kept.join('\n');
}

// 只接收可逐行编辑的语句；多行数组/字符串及特殊表头必须先整理，避免误删后续表
export function validateToml(content: string): Record<string, unknown> {
  const parsed = parse(content) as Record<string, unknown>;
  for (const line of content.split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    if (text.startsWith('[')) {
      if (!isTomlTableHeader(text)) throw new Error('Unsupported TOML table header for safe editing.');
      continue;
    }
    const equals = text.indexOf('=');
    if (equals < 1) throw new Error('Unsupported multiline TOML statement for safe editing.');
    const raw = text.slice(equals + 1);
    if (raw.includes(String.fromCharCode(34).repeat(3)) || raw.includes(String.fromCharCode(39).repeat(3))) throw new Error('Multiline TOML strings are not supported for safe editing.');
    parse('value =' + raw);
  }
  return parsed;
}

// 保留等号前的缩进和行尾注释，字符串中的 # 不算注释
function replaceValue(line: string, rawValue: string): string {
  const equals = line.indexOf('=');
  const after = line.slice(equals + 1);
  let quote = ''; let escaped = false; let comment = after.length;
  for (let i = 0; i < after.length; i++) {
    const ch = after[i];
    if (quote === '"' && !escaped && ch === String.fromCharCode(92)) { escaped = true; continue; }
    if (!escaped && (ch === '"' || ch === String.fromCharCode(39))) {
      if (!quote) quote = ch;
      else if (quote === ch) quote = '';
    }
    if (!quote && ch === '#') { comment = i; break; }
    escaped = false;
  }
  const suffix = comment < after.length ? after.slice(0, comment).match(/\s*$/)![0] + after.slice(comment) : line.endsWith('\r') ? '\r' : '';
  const lead = after.match(/^[ \t]*/)?.[0] ?? ' ';
  return line.slice(0, equals + 1) + lead + rawValue + suffix;
}
function checked(content: string, edit: () => string): string {
  validateToml(content);
  const next = edit(); validateToml(next); return next;
}
export function upsertTopLevelTomlKey(content: string, key: string, rawValue: string): string {
  return checked(content, () => rawupsertTopLevelTomlKey(content, key, rawValue));
}
export function removeTopLevelTomlKey(content: string, key: string): string {
  return checked(content, () => rawremoveTopLevelTomlKey(content, key));
}
export function removeTomlTablesWhere(content: string, match: (name: string) => boolean): string {
  return checked(content, () => rawremoveTomlTablesWhere(content, match));
}
export function upsertTomlTableKey(content: string, tableName: string, key: string, rawValue: string): string {
  return checked(content, () => rawupsertTomlTableKey(content, tableName, key, rawValue));
}
export function removeTomlTableKey(content: string, tableName: string, key: string): string {
  return checked(content, () => rawremoveTomlTableKey(content, tableName, key));
}
