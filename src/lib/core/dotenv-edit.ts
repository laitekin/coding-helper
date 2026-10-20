// 按行编辑 .env：只改动指定变量，保留其他行和注释

function keyPattern(key: string): RegExp {
  return new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
}

// 读取变量的原始值文本（引号原样保留），不存在时返回 undefined
export function getDotenvValue(content: string, key: string): string | undefined {
  const line = content.split('\n').find((l) => keyPattern(key).test(l));
  return line === undefined ? undefined : line.replace(keyPattern(key), '').trim();
}

// 设置变量；rawValue 原样写入
export function setDotenvValue(content: string, key: string, rawValue: string): string {
  const lines = content ? content.split('\n') : [];
  const index = lines.findIndex((l) => keyPattern(key).test(l));
  if (index >= 0) {
    lines[index] = `${key}=${rawValue}`;
    return lines.join('\n');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  lines.push(`${key}=${rawValue}`, '');
  return lines.join('\n');
}

export function removeDotenvValue(content: string, key: string): string {
  return content.split('\n').filter((l) => !keyPattern(key).test(l)).join('\n');
}
