// 只编辑单行环境变量，其他行原样保留；危险控制字符拒绝写入
export function setDotenvValue(content: string, key: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) throw new Error('Invalid environment variable.');
  const pattern = new RegExp('^\\s*(?:export\\s+)?' + key + '\\s*=');
  const lines = content.split('\n');
  const matches = lines.map((line, i) => pattern.test(line) ? i : -1).filter(i => i >= 0);
  if (matches.length > 1) throw new Error('Duplicate environment variable: ' + key);
  if (!/^[A-Za-z0-9_./:+\-=]+$/.test(value)) throw new Error('API key contains unsupported .env characters.');
  const next = key + '=' + value;
  if (matches.length) {
    const i = matches[0];
    if (!/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:[^"']*|"[^"\r\n]*"|'[^'\r\n]*')\s*$/.test(lines[i])) throw new Error('Unsupported multiline environment value.');
    lines[i] = next + (lines[i].endsWith('\r') ? '\r' : '');
    return lines.join('\n');
  }
  return content + (content && !content.endsWith('\n') ? '\n' : '') + next + '\n';
}
