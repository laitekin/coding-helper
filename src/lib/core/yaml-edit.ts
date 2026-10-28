import { isAlias, isMap, isScalar, parseDocument, visit, type Document } from 'yaml';

// 保留文档节点上的注释和引号；损坏或非映射配置不能当作空对象覆盖
export function parseYamlDocument(content: string): Document {
  const doc: Document = parseDocument(content);
  if (doc.errors.length) throw doc.errors[0];
  // Editing an anchor also changes its aliases, including unrelated fields.
  visit(doc, { Node(_key, node) {
    if (isAlias(node) || ('anchor' in node && node.anchor)) throw new Error('YAML anchors and aliases are not supported for safe editing.');
  } });
  if (!doc.contents) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) throw new Error('YAML configuration must be a mapping.');
  return doc;
}

export function setYamlValue(doc: Document, keys: string[], value: unknown): void {
  if (!keys.length) throw new Error('YAML path must not be empty.');
  for (let depth = 1; depth < keys.length; depth++) {
    const parent = keys.slice(0, depth);
    if (!doc.hasIn(parent)) doc.setIn(parent, doc.createNode({}));
    else if (!isMap(doc.getIn(parent, true))) throw new Error('YAML parent must be a mapping: ' + parent.join('.'));
  }
  const node = doc.getIn(keys, true);
  if (isScalar(node) && (value === null || typeof value !== 'object')) node.value = value;
  else doc.setIn(keys, doc.createNode(value));
}

export function getYamlValue(doc: Document, keys: string[]): unknown {
  const value = doc.getIn(keys);
  return value && typeof value === 'object' && 'toJSON' in value
    ? (value as { toJSON(): unknown }).toJSON() : value;
}

export function deleteYamlValue(doc: Document, keys: string[]): void {
  if (!keys.length) throw new Error('YAML path must not be empty.');
  const parent = keys.length > 1 ? doc.getIn(keys.slice(0, -1), true) : doc.contents;
  if (!isMap(parent)) return;
  doc.deleteIn(keys);
}

// undefined 表示缺失，null 是合法 YAML 值
export function restoreYamlValue(doc: Document, keys: string[], value: unknown): void {
  if (value === undefined) deleteYamlValue(doc, keys);
  else setYamlValue(doc, keys, value);
}

export function stringifyYamlDocument(doc: Document): string {
  return String(doc);
}

export function setYamlLine(content: string, parent: string, key: string, value: string): string {
  const doc = parseYamlDocument(content);
  setYamlValue(doc, [parent, key], value);
  return stringifyYamlDocument(doc);
}
