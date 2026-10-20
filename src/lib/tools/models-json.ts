import type { PriorValues } from '../core/state-store.js';

// CodeBuddy / WorkBuddy 共用的 models.json 合并逻辑：只增删 vendor 为 Qiniu 的条目，
// 其他字段的值与顺序保持不变；卸载时按原状删除我们新增的字段

export const QINIU_VENDOR = 'Qiniu';

interface VendorModel {
  id: string;
  vendor?: string;
}

function isQiniu(model: unknown): boolean {
  return !!model && typeof model === 'object' && (model as VendorModel).vendor === QINIU_VENDOR;
}

function modelList(config: Record<string, unknown>): VendorModel[] {
  return Array.isArray(config.models) ? (config.models as VendorModel[]) : [];
}

// 首次写入前记录哪些顶层字段原本存在
export function captureModelsJsonPriors(config: Record<string, unknown>): PriorValues {
  return {
    'models.existed': Array.isArray(config.models),
    'availableModels.existed': Array.isArray(config.availableModels),
  };
}

// 写入七牛模型：替换已有的七牛条目并去重，availableModels 同步更新；修改原对象以保留键顺序
export function applyModelsJson(
  config: Record<string, unknown>,
  qiniuModels: VendorModel[],
): Record<string, unknown> {
  const next = structuredClone(config);
  const seen = new Set<string>();
  next.models = [...modelList(next).filter((m) => !isQiniu(m)), ...qiniuModels].filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  const qiniuIds = new Set(qiniuModels.map((m) => m.id));
  const previousQiniuIds = new Set(modelList(config).filter(isQiniu).map((m) => m.id));
  next.availableModels = Array.isArray(next.availableModels)
    ? [...new Set([
      ...(next.availableModels as string[]).filter((id) => !previousQiniuIds.has(id) && !qiniuIds.has(id)),
      ...qiniuIds,
    ])]
    : (next.models as VendorModel[]).map((m) => m.id);
  return next;
}

// 移除七牛模型；原本不存在的 models / availableModels 字段一并删除
export function revertModelsJson(config: Record<string, unknown>, priors: PriorValues): Record<string, unknown> {
  const next = structuredClone(config);
  const qiniuIds = new Set(modelList(next).filter(isQiniu).map((m) => m.id));
  const remaining = modelList(next).filter((m) => !isQiniu(m));
  if (remaining.length === 0 && priors['models.existed'] === false) delete next.models;
  else if (Array.isArray(next.models)) next.models = remaining;

  if (priors['availableModels.existed'] === false) delete next.availableModels;
  else if (Array.isArray(next.availableModels)) {
    const keep = new Set(remaining.map((m) => m.id));
    next.availableModels = (next.availableModels as string[]).filter((id) => !qiniuIds.has(id) || keep.has(id));
  }
  return next;
}

export function hasQiniuModels(config: Record<string, unknown>): boolean {
  return modelList(config).some(isQiniu);
}
