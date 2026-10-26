// 线路定义 - 七牛 API 端点
export interface EndpointDefinition {
  id: string;
  // i18n key，用于获取显示名称（如 'endpoint_china'）
  i18nKey: string;
  baseUrl: string;
}

export const ENDPOINT_DEFINITIONS: Record<string, EndpointDefinition> = {
  china: {
    id: 'china',
    i18nKey: 'endpoint_china',
    baseUrl: 'https://api.qnaigc.com',
  },
  international: {
    id: 'international',
    i18nKey: 'endpoint_international',
    baseUrl: 'https://api.modelink.ai',
  },
};

export const DEFAULT_ENDPOINT = 'china';

// 自定义线路：地址保存在配置里（如私有化部署、代理网关）
export const CUSTOM_ENDPOINT = 'custom';

// 配置里的自定义地址，由 configManager 加载时登记
let customBaseUrls: string[] = [];

export function registerCustomBaseUrls(urls: string[]): void {
  customBaseUrls = urls.map((u) => u.replace(/\/+$/, ''));
}

// 旧线路 id 到新线路 id 的兼容映射（历史配置迁移）
// 老用户 config.yaml 里可能存有已移除的 id，读取时规范化到对应新线路
const LEGACY_ENDPOINT_ALIASES: Record<string, string> = {
  qiniu: 'china',           // 旧 openai.qiniu.com → 国内线路 api.qnaigc.com
  modelink: 'international', // 旧 api.modelink.ai → 海外线路（地址不变）
};

// 规范化端点 id：已知旧 id 映射到新 id，其余原样返回
export function normalizeEndpointId(endpointId: string): string {
  return LEGACY_ENDPOINT_ALIASES[endpointId] ?? endpointId;
}

// 测试用：CODING_HELPER_BASE_URL_CHINA / _INTERNATIONAL 可把线路指向本地模拟服务
function overrideFor(endpointId: string): string | undefined {
  return process.env[`CODING_HELPER_BASE_URL_${endpointId.toUpperCase()}`] || undefined;
}

// 根据端点 ID 获取 base URL
export function getBaseUrl(endpointId: string): string {
  const id = ENDPOINT_DEFINITIONS[normalizeEndpointId(endpointId)] ? normalizeEndpointId(endpointId) : DEFAULT_ENDPOINT;
  return overrideFor(id) ?? ENDPOINT_DEFINITIONS[id].baseUrl;
}

// 另一条线路的 id（国内 ↔ 海外）
export function otherEndpoint(endpointId: string): string {
  return normalizeEndpointId(endpointId) === 'international' ? 'china' : 'international';
}

// 判断 URL 是否指向七牛线路（含历史域名），用于识别旧版本写入的配置
export function isQiniuBaseUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const known = [
    ...Object.values(ENDPOINT_DEFINITIONS).map((def) => def.baseUrl),
    ...Object.keys(ENDPOINT_DEFINITIONS).map(overrideFor).filter((u): u is string => !!u),
    ...customBaseUrls,
    'https://openai.qiniu.com',
  ];
  return known.some((base) => url.replace(/\/+$/, '').startsWith(base));
}
