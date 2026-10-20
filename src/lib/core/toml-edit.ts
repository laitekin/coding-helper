// 按行编辑 TOML：只改动指定的键和表，保留注释、顺序和其他内容

export function isTomlTableHeader(line: string): boolean {
  return /^\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(line.trim());
}

// 表头中的表名，如 [models."qiniu/x"] → models."qiniu/x"
export function tomlTableName(line: string): string | undefined {
  const match = line.trim().match(/^\[\[?\s*(.+?)\s*\]\]?\s*(#.*)?$/);
  return match ? match[1] : undefined;
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
export function upsertTopLevelTomlKey(content: string, key: string, rawValue: string): string {
  const lines = content.split('\n');
  const end = topLevelEnd(lines);
  const pattern = topLevelKeyPattern(key);
  const line = `${key} = ${rawValue}`;
  const index = lines.findIndex((l, i) => i < end && pattern.test(l.trim()));
  if (index >= 0) {
    lines[index] = line;
    return lines.join('\n');
  }
  let insertAt = end;
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, line);
  // 紧挨着表头时补一个空行，保持可读
  if (insertAt + 1 < lines.length && isTomlTableHeader(lines[insertAt + 1])) {
    lines.splice(insertAt + 1, 0, '');
  }
  return lines.join('\n');
}

// 删除顶层键
export function removeTopLevelTomlKey(content: string, key: string): string {
  const lines = content.split('\n');
  const end = topLevelEnd(lines);
  const pattern = topLevelKeyPattern(key);
  return lines.filter((line, i) => i >= end || !pattern.test(line.trim())).join('\n');
}

// 删除表名满足条件的所有表（含其下的键）
export function removeTomlTablesWhere(content: string, match: (name: string) => boolean): string {
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
  return removeTomlTablesWhere(content, (name) => name === tableName || name.startsWith(`${tableName}.`));
}

export function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function normalizeToml(content: string): string {
  const trimmed = content.trim();
  return trimmed ? `${trimmed}\n` : '';
}
