// 简单的逐行差异（LCS），用于 --dry-run 预览；配置文件都不大，O(n·m) 足够
export type DiffLine = { kind: ' ' | '+' | '-'; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.replace(/\n$/, '').split('\n') : [];
  const b = after ? after.replace(/\n$/, '').split('\n') : [];
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ kind: ' ', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ kind: '-', text: a[i++] });
    } else {
      result.push({ kind: '+', text: b[j++] });
    }
  }
  while (i < a.length) result.push({ kind: '-', text: a[i++] });
  while (j < b.length) result.push({ kind: '+', text: b[j++] });
  return result;
}

// 只保留变更行及其前后 context 行，中间省略处用 null 表示
export function withContext(lines: DiffLine[], context = 2): (DiffLine | null)[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === ' ') return;
    for (let k = index - context; k <= index + context; k++) keep.add(k);
  });
  const result: (DiffLine | null)[] = [];
  let skipped = false;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      result.push(line);
      skipped = false;
    } else if (!skipped) {
      result.push(null);
      skipped = true;
    }
  });
  return result;
}
