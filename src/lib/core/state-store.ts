import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, helperDir, readTextFile } from './safe-write.js';

// 被七牛覆盖前的原值；null 表示原本不存在
export type PriorValues = Record<string, unknown>;

export interface ToolState {
  // 首次写入前记录的原值，卸载时按此还原
  priors?: PriorValues;
}

interface StateFile {
  version: 1;
  tools: Record<string, ToolState>;
}

// 记录客户端被覆盖前的原值（~/.coding-helper/state.json）
class StateStore {
  private file(): string {
    return path.join(helperDir(), 'state.json');
  }

  private read(): StateFile {
    try {
      const content = readTextFile(this.file());
      if (content) {
        const parsed = JSON.parse(content) as Partial<StateFile>;
        if (parsed && typeof parsed.tools === 'object' && parsed.tools) {
          return { version: 1, tools: parsed.tools };
        }
      }
    } catch {
      // 状态文件损坏时按空状态处理，不影响主流程
    }
    return { version: 1, tools: {} };
  }

  private write(state: StateFile): void {
    atomicWriteFile(this.file(), JSON.stringify(state, null, 2) + '\n');
  }

  // 卸载后移除记录（连同原值），下次装载重新记录
  markRemoved(tool: string): void {
    const state = this.read();
    if (!state.tools[tool]) return;
    delete state.tools[tool];
    this.write(state);
  }

  getPriors(tool: string): PriorValues | undefined {
    return this.read().tools[tool]?.priors;
  }

  // 只记录第一次看到的原值，重复装载时不会被七牛自己写入的值覆盖
  recordPriors(tool: string, priors: PriorValues): void {
    const state = this.read();
    const current = state.tools[tool];
    const merged: PriorValues = { ...priors, ...(current?.priors ?? {}) };
    state.tools[tool] = { ...current, priors: merged };
    this.write(state);
  }

  clear(): void {
    fs.rmSync(this.file(), { force: true });
  }
}

export const stateStore = new StateStore();
