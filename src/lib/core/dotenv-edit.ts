// 只编辑单行环境变量，其他行原样保留；危险控制字符拒绝写入
export function setDotenvValue(content: string, key: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) throw new Error('Invalid environment variable.');
  const pattern = new RegExp('^\\s*(?:export\\s+)?' + key + '\\s*=');
  const lines = content.split('\n');
  // Refuse multiline quoted assignments before matching a target on any line.
  // A target-looking line may be part of another variable's quoted value.
  for (const line of lines) {
    const assignment = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/);
    if (!assignment) continue;
    const raw = assignment[1];
    if (!['"', "'", String.fromCharCode(96)].includes(raw[0])) continue;
    let closed = false;
    for (let i = 1; i < raw.length; i++) {
      if (raw[i] === raw[0] && (raw[0] === "'" || raw[i - 1] !== String.fromCharCode(92))) { closed = true; break; }
    }
    if (!closed) throw new Error('Unsupported multiline environment value.');
  }
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
