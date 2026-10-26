import type { ITool } from './tools/base-tool.js';

// 工具列表的取值入口：界面层通过它读取工具，避免 ui-renderer ↔ tool-manager 的循环引用
let provider: () => ITool[] = () => [];

export function registerToolProvider(fn: () => ITool[]): void {
  provider = fn;
}

export function registeredTools(): ITool[] {
  return provider();
}
