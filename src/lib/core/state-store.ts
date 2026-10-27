import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, ConfigParseError, helperDir, readTextFile } from './safe-write.js';

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
    const file = this.file();
    const content = readTextFile(file);
    if (content === undefined) return { version: 1, tools: {} };
    try {
      const parsed: unknown = JSON.parse(content);
      const record = (value: unknown): value is Record<string, unknown> =>
        value !== null && typeof value === 'object' && !Array.isArray(value);
      if (!record(parsed) || parsed.version !== 1 || !record(parsed.tools) ||
          Object.values(parsed.tools).some((entry) => !record(entry) ||
            (entry.priors !== undefined && !record(entry.priors)))) {
        throw new Error('Invalid or unsupported restoration state');
      }
      return { version: 1, tools: parsed.tools as Record<string, ToolState> };
    } catch (err) {
      // 不能把损坏的还原记录当空状态，否则后续装载会覆盖唯一的原值
      throw new ConfigParseError(file, err);
    }
  }

  private write(state: StateFile): void {
    atomicWriteFile(this.file(), JSON.stringify(state, null, 2) + '\n');
  }

  // 文件路径参与身份，防止不同 XDG 配置目录共享还原记录
  private key(tool: string, file?: string): string {
    return file === undefined ? tool : JSON.stringify([tool, path.resolve(file)]);
  }

  // 卸载后移除记录（连同原值），下次装载重新记录
  markRemoved(tool: string, file?: string): void {
    tool = this.key(tool, file);
    const state = this.read();
    if (!state.tools[tool]) return;
    delete state.tools[tool];
    this.write(state);
  }

  getPriors(tool: string, file?: string): PriorValues | undefined {
    tool = this.key(tool, file);
    const tools = this.read().tools;
    return Object.hasOwn(tools, tool) ? tools[tool]?.priors : undefined;
  }

  // 只记录第一次看到的原值，重复装载时不会被七牛自己写入的值覆盖
  recordPriors(tool: string, priors: PriorValues, file?: string): void {
    tool = this.key(tool, file);
    const state = this.read();
    const current = Object.hasOwn(state.tools, tool) ? state.tools[tool] : undefined;
    const merged: PriorValues = { ...priors, ...(current?.priors ?? {}) };
    Object.defineProperty(state.tools, tool, { value: { ...current, priors: merged }, enumerable: true, configurable: true, writable: true });
    this.write(state);
  }

  clear(): void {
    fs.rmSync(this.file(), { force: true });
  }
}

export const stateStore = new StateStore();
