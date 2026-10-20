import { isMap, isScalar, parseDocument, type Document } from 'yaml';

// 按文档编辑 YAML：只改目标键，保留注释、空行、顺序与原有引号风格

export function parseYamlDocument(content: string): Document {
  const doc = parseDocument(content || '');
  if (doc.errors.length > 0) throw doc.errors[0];
  if (!doc.contents) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
  return doc;
}

// 设置标量：已存在时只改值（保留引号风格与注释），否则新增
export function setYamlValue(doc: Document, path: string[], value: unknown): void {
  const parentPath = path.slice(0, -1);
  if (parentPath.length > 0 && !isMap(doc.getIn(parentPath, true))) {
    doc.setIn(parentPath, doc.createNode({}));
  }
  const node = doc.getIn(path, true);
  if (isScalar(node) && (value === null || typeof value !== 'object')) {
    node.value = value;
    return;
  }
  doc.setIn(path, value);
}

export function getYamlValue(doc: Document, path: string[]): unknown {
  const value = doc.getIn(path);
  return value && typeof value === 'object' && 'toJSON' in value
    ? (value as { toJSON(): unknown }).toJSON()
    : value;
}

// 删除键；父级映射因此变空时一并删除
export function deleteYamlValue(doc: Document, path: string[]): void {
  // 路径不存在（或中间不是映射）时无事可做
  const parent = path.length > 1 ? doc.getIn(path.slice(0, -1), true) : doc.contents;
  if (!isMap(parent) || !parent.has(path[path.length - 1])) return;
  doc.deleteIn(path);
  for (let depth = path.length - 1; depth > 0; depth--) {
    const parent = doc.getIn(path.slice(0, depth), true);
    if (!isMap(parent) || parent.items.length > 0) break;
    doc.deleteIn(path.slice(0, depth));
  }
}

// 原值为 null/undefined 时删除，否则写回
export function restoreYamlValue(doc: Document, path: string[], prior: unknown): void {
  if (prior === null || prior === undefined) deleteYamlValue(doc, path);
  else setYamlValue(doc, path, prior);
}

export function stringifyYamlDocument(doc: Document): string {
  const contents = doc.contents;
  if (isMap(contents) && contents.items.length === 0 && !doc.commentBefore && !doc.comment) return '';
  return String(doc);
}

// ---- 按行编辑两层的块状 YAML（parent: 下的 key: value），其余每一行原样保留 ----

interface BlockRange {
  header: number;
  end: number; // 块结束位置（不含）
  childIndent: string | undefined;
}

function findBlock(lines: string[], parent: string): BlockRange | undefined {
  const header = lines.findIndex((line) => new RegExp(`^${parent}:\\s*(#.*)?$`).test(line));
  if (header < 0) return undefined;
  let end = header + 1;
  let childIndent: string | undefined;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && !line.trim().startsWith('#') && !/^\s/.test(line)) break;
    if (!childIndent && /^\s+[^\s#][^:]*:/.test(line)) childIndent = line.match(/^\s+/)![0];
    end++;
  }
  // 块尾部的注释与空行属于下一段，不算进块里
  while (end > header + 1 && !/^\s+[^\s#]/.test(lines[end - 1])) end--;
  return { header, end, childIndent };
}

function keyLineIndex(lines: string[], block: BlockRange, key: string): number {
  if (!block.childIndent) return -1;
  const pattern = new RegExp(`^${block.childIndent}${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\s|$)`);
  for (let i = block.header + 1; i < block.end; i++) if (pattern.test(lines[i])) return i;
  return -1;
}

// 拆出值与行尾注释：key: "v"  # c → { raw: '"v"', rest: '  # c' }
function splitValue(afterColon: string): { raw: string; rest: string } {
  const text = afterColon.replace(/^\s+/, '');
  const lead = afterColon.slice(0, afterColon.length - text.length);
  let end = text.length;
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    let i = 1;
    while (i < text.length && !(text[i] === quote && text[i - 1] !== '\\')) i++;
    end = i + 1;
  } else {
    const comment = text.search(/\s#/);
    if (comment >= 0) end = comment;
    while (end > 0 && /\s/.test(text[end - 1])) end--;
  }
  return { raw: lead + text.slice(0, end), rest: text.slice(end) };
}

function formatLike(raw: string, value: string): string {
  const lead = raw.match(/^\s*/)![0] || ' ';
  const body = raw.trim();
  if (body.startsWith('"')) return `${lead}${JSON.stringify(value)}`;
  if (body.startsWith("'")) return `${lead}'${value.replace(/'/g, "''")}'`;
  // 纯量写法：值里有特殊字符时加双引号
  return `${lead}${/^[\w./:@-]+$/.test(value) && !/^(true|false|null|~|yes|no|on|off)$/i.test(value) ? value : JSON.stringify(value)}`;
}

// 设置 parent.key 的字符串值；已存在时原地替换（保留引号风格与行尾注释），否则插入到块末尾
export function setYamlLine(content: string, parent: string, key: string, value: string): string {
  const lines = content.split('\n');
  const block = findBlock(lines, parent);
  if (!block) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${parent}:`, `  ${key}: ${formatLike(' ', value).trim()}`, '');
    return lines.join('\n');
  }
  const index = keyLineIndex(lines, block, key);
  if (index >= 0) {
    const prefix = lines[index].slice(0, lines[index].indexOf(':') + 1);
    const { raw, rest } = splitValue(lines[index].slice(prefix.length));
    lines[index] = `${prefix}${formatLike(raw, value)}${rest}`;
    return lines.join('\n');
  }
  const indent = block.childIndent ?? '  ';
  lines.splice(block.end, 0, `${indent}${key}: ${formatLike(' ', value).trim()}`);
  return lines.join('\n');
}

// 删除 parent.key 这一行；块因此没有子键时连同 parent: 一起删除
export function removeYamlLine(content: string, parent: string, key: string): string {
  const lines = content.split('\n');
  const block = findBlock(lines, parent);
  if (!block) return content;
  const index = keyLineIndex(lines, block, key);
  if (index < 0) return content;
  lines.splice(index, 1);
  const after = findBlock(lines, parent);
  if (after && !lines.slice(after.header + 1, after.end).some((l) => /^\s+[^\s#]/.test(l))) {
    lines.splice(after.header, after.end - after.header);
  }
  return lines.join('\n');
}
