import { configManager, type ModelConfig } from '../config.js';
import { toolManager } from '../tool-manager.js';
import type { ITool } from '../tools/base-tool.js';
import { stateStore } from './state-store.js';

// 单个客户端的操作结果
export type ToolResultStatus = 'success' | 'skipped' | 'failed';

export interface ToolResult {
  tool: ITool;
  status: ToolResultStatus;
  // 跳过或失败原因（skipped 时为 i18n key，failed 时为错误信息）
  reason?: string;
}

export interface ToolDetection {
  tool: ITool;
  // null 表示无法检测（桌面应用）
  installed: boolean | null;
  version: string | null;
  configured: boolean;
}

// 判断 coding-helper 自身是否保存过该工具的模型配置状态
export function hasSavedToolModelConfig(
  tool: Pick<ITool, 'name'>,
  models: ModelConfig,
): boolean {
  switch (tool.name) {
    case 'claude-code':
      return !!(
        models.claudeCode?.useDefaultModels ||
        models.claudeCode?.haikuModel ||
        models.claudeCode?.sonnetModel ||
        models.claudeCode?.opusModel ||
        models.claudeCode?.subagentModel
      );
    case 'codex':
      return !!models.codexModel;
    case 'codebuddy':
      return !!models.codeBuddyModels?.length;
    case 'workbuddy':
      return !!models.workbuddyModels?.length;
    case 'hermes':
      return !!models.hermesModel;
    default:
      // 通用客户端：单独选过模型，或已有通用默认模型
      return !!(models.toolModels?.[tool.name] || models.defaultModel);
  }
}

// 检测单个客户端的安装与配置状态
export function detectTool(tool: ITool): ToolDetection {
  const installed = tool.isInstalled();
  let configured = false;
  try {
    configured = tool.isConfigured();
  } catch {
    // 配置文件损坏时视为未配置，由装载流程给出具体错误
  }
  return {
    tool,
    installed,
    version: installed ? tool.getVersion() : null,
    configured,
  };
}

export function detectAllTools(): ToolDetection[] {
  return toolManager.getAll().map(detectTool);
}

// 把当前 API Key、线路与模型写入客户端，并记录装载状态
export async function applyTool(tool: ITool): Promise<ToolResult> {
  const apiKey = configManager.getApiKey();
  if (!apiKey) return { tool, status: 'failed', reason: 'apikey_not_set' };

  if (tool.launchOnly) return { tool, status: 'skipped', reason: 'setup_reason_launch_only' };

  const models = configManager.getModels();
  if (tool.requiresModelSelection && !hasSavedToolModelConfig(tool, models)) {
    return { tool, status: 'skipped', reason: 'setup_reason_models_required' };
  }

  try {
    await tool.loadConfig(apiKey, configManager.baseUrl, models);
    stateStore.markApplied(tool.name, configManager.getEndpoint());
    return { tool, status: 'success' };
  } catch (err: unknown) {
    return { tool, status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

// 从客户端移除七牛配置，并按记录的原值还原
export async function removeTool(tool: ITool): Promise<ToolResult> {
  try {
    await tool.unloadConfig();
    stateStore.markRemoved(tool.name);
    return { tool, status: 'success' };
  } catch (err: unknown) {
    return { tool, status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

// 需要同步的客户端：有装载记录，或旧版本已写过七牛配置
export function getSyncTargets(): ITool[] {
  const applied = new Set(stateStore.getApplied());
  return toolManager.getAll().filter((tool) => {
    if (tool.launchOnly) return false;
    if (applied.has(tool.name)) return true;
    try {
      return tool.isConfigured();
    } catch {
      return false;
    }
  });
}

// API Key 或线路变更后，把新配置重新写入已装载的客户端
export async function syncAppliedTools(
  onProgress?: (tool: ITool) => void,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const tool of getSyncTargets()) {
    onProgress?.(tool);
    results.push(await applyTool(tool));
  }
  return results;
}

// 结果汇总对应的退出码：0 全部成功，2 部分失败，1 全部失败
export function exitCodeFor(results: ToolResult[]): number {
  const failed = results.filter((r) => r.status === 'failed').length;
  if (failed === 0) return 0;
  return failed === results.length ? 1 : 2;
}
