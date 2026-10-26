import { getModelCapabilities, type MarketModelInfo } from '../market-model-service.js';

export interface QiniuModel {
  id: string;
  name: string;
  vendor: string;
  url: string;
  apiKey: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  temperature: number;
  supportsToolCall: boolean;
  supportsImages: boolean;
}

// CodeBuddy / WorkBuddy 使用相同的模型描述格式。
export function toQiniuModel(model: MarketModelInfo, apiKey: string, baseUrl: string): QiniuModel {
  const caps = getModelCapabilities(model);
  return {
    id: model.id,
    name: model.name,
    vendor: 'Qiniu',
    url: baseUrl.replace(/\/+$/, '') + '/v1/chat/completions',
    apiKey,
    maxInputTokens: caps.maxInputTokens,
    maxOutputTokens: caps.maxOutputTokens,
    temperature: 0.7,
    supportsToolCall: caps.toolCall,
    supportsImages: caps.images,
  };
}

// 沿用现有规则：替换七牛条目，同 ID 优先保留用户已有的其他供应商模型。
export function mergeQiniuModels(
  existing: Record<string, unknown>,
  qiniuModels: QiniuModel[],
): Record<string, unknown> {
  const current = Array.isArray(existing.models) ? existing.models as QiniuModel[] : [];
  const seen = new Set<string>();
  const models = [...current.filter(model => model.vendor !== 'Qiniu'), ...qiniuModels].filter(model => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
  return { ...existing, models, availableModels: models.map(model => model.id) };
}
