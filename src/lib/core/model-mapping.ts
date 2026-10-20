import type { ModelConfig } from '../config.js';
import type { ITool } from '../tools/base-tool.js';

// 把一个模型 ID 写到各工具对应的配置项
export function modelConfigFor(tool: Pick<ITool, 'name'>, model: string): ModelConfig {
  switch (tool.name) {
    case 'claude-code':
      // Claude Code 有 4 个模型位，单条命令只给一个模型时全部使用它
      return {
        claudeCode: {
          haikuModel: model,
          sonnetModel: model,
          opusModel: model,
          subagentModel: model,
          useDefaultModels: false,
        },
      };
    case 'codex':
      return { codexModel: model };
    case 'codebuddy':
      return { codeBuddyModels: [model] };
    case 'workbuddy':
      return { workbuddyModels: [model] };
    case 'hermes':
      return { hermesModel: model };
    default:
      return { toolModels: { [tool.name]: model } };
  }
}

// 工具已保存的模型（用于未指定模型时优先沿用）
export function savedModelFor(tool: Pick<ITool, 'name'>, models: ModelConfig): string | undefined {
  switch (tool.name) {
    case 'claude-code':
      return models.claudeCode?.sonnetModel;
    case 'codex':
      return models.codexModel;
    case 'codebuddy':
      return models.codeBuddyModels?.[0];
    case 'workbuddy':
      return models.workbuddyModels?.[0];
    case 'hermes':
      return models.hermesModel;
    default:
      return models.toolModels?.[tool.name] ?? models.defaultModel;
  }
}
