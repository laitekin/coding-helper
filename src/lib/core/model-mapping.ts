import type { ModelConfig } from '../config.js';
import type { ITool } from '../tools/base-tool.js';
import { slotModel } from './model-slots.js';

// 把一个模型 ID 写到各工具对应的配置项；models 用于读取单独设置过的槽位
export function modelConfigFor(tool: Pick<ITool, 'name'>, model: string, models?: ModelConfig): ModelConfig {
  switch (tool.name) {
    case 'claude-code':
      // 主模型 = Sonnet · Opus（Fable 同 Opus）；兜底（Haiku）与子代理默认跟随主模型
      return {
        claudeCode: {
          haikuModel: slotModel(tool.name, 'fallback', model, models),
          sonnetModel: model,
          opusModel: model,
          subagentModel: slotModel(tool.name, 'subagent', model, models),
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
