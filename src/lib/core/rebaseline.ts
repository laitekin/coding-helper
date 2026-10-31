import fs from 'node:fs';
import path from 'node:path';
import type { ITool } from '../tools/base-tool.js';
import { stateStore, type ToolState } from './state-store.js';
import { atomicWriteFile, backupsRoot, isPreview, readTextFile } from './safe-write.js';

// 还原记录涉及的文件：记录键本身，以及多文件事务里列出的全部目标
function recordFiles(states: { file: string; state: ToolState }[]): string[] {
  const files = new Set<string>();
  for (const { file, state } of states) {
    files.add(file);
    const listed = state.priors?.files;
    if (Array.isArray(listed)) for (const entry of listed) {
      if (entry && typeof entry === 'object' && typeof (entry as { file?: unknown }).file === 'string') files.add((entry as { file: string }).file);
    }
  }
  return [...files];
}

// 是否有还原记录（文件记录或旧版按工具名的记录）
export function hasRestoreRecord(tool: Pick<ITool, 'name'>): boolean {
  try { return stateStore.getRecordedTools().includes(tool.name); } catch { return false; }
}

// 有还原记录、但当前配置已不指向七牛：通常是用户在外部切换到了其他服务
export function isExternallyModified(tool: ITool): boolean {
  if (tool.launchOnly || !hasRestoreRecord(tool)) return false;
  try { return tool.isConfigured?.() === false; } catch { return false; }
}

export interface RebaselineResult { backupDir?: string; files: string[]; }

// 以当前配置为新的还原基线：先把旧记录和当前文件归档到 backups/rebaseline-*，再删除旧记录。
// 之后正常装载七牛时，当前配置会被记录为原值，还原会回到它。预演中只在内存视图里删除记录。
export function rebaselineTool(tool: ITool): RebaselineResult {
  return stateStore.withLock(() => {
    // 仍指向七牛时旧记录是唯一能撤销七牛的依据，不能被当前配置替换
    if (tool.isConfigured?.() === true) throw new Error('Current configuration still uses Qiniu. Restore it instead of rebaselining.');
    const states = stateStore.getFileStates(tool.name);
    const legacy = stateStore.getState(tool.name);
    if (!states.length && !legacy) return { files: [] };
    if ([...states.map(entry => entry.state), legacy].some(state => state?.pending)) {
      throw new Error('An interrupted write requires recovery before rebaselining.');
    }
    const files = recordFiles(states);
    let backupDir: string | undefined;
    if (!isPreview()) {
      const root = backupsRoot();
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      backupDir = fs.mkdtempSync(path.join(root, `rebaseline-${tool.name}-`));
      const copies: { source: string; backup: string | null }[] = [];
      files.forEach((file, index) => {
        const content = readTextFile(file);
        const backup = content === undefined ? null : path.join(backupDir!, `${index}-${path.basename(file)}`);
        if (backup) atomicWriteFile(backup, content!);
        copies.push({ source: file, backup });
      });
      const records = Object.fromEntries([...states.map(({ file, state }) => [file, state]), ...(legacy ? [[tool.name, legacy]] : [])]);
      // 清单先落盘，删除记录失败时仍可从归档恢复
      atomicWriteFile(path.join(backupDir, 'manifest.json'), JSON.stringify({ tool: tool.name, createdAt: new Date().toISOString(), files: copies, records }, null, 2) + '\n');
    }
    stateStore.removeToolRecords(tool.name);
    return { backupDir, files };
  });
}
