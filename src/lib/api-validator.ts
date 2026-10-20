import { t } from './i18n.js';

// API Key 验证结果
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// 通过 GET {baseUrl}/v2/stat/usage 验证 API Key
export async function validateApiKey(
  apiKey: string,
  baseUrl: string,
): Promise<ValidationResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    // 构造当天日期，最小化查询范围
    const today = new Date().toISOString().slice(0, 10);
    const url = `${baseUrl}/v2/stat/usage?granularity=day&start=${today}T00:00:00%2B08:00&end=${today}T23:59:59%2B08:00`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      return { valid: true };
    }

    // 根据状态码返回错误
    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: 'Invalid API Key' };
    }

    return { valid: false, error: `HTTP ${response.status}` };
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return { valid: false, error: t('error_timeout') };
      }
      return { valid: false, error: error.message };
    }
    return { valid: false, error: t('error_unknown') };
  }
}

// 账户可用性：Key 有效不代表能调用模型（如欠费暂停）
export interface AccountStatus {
  usable: boolean;
  // 不可用时的服务端错误码与信息，如 account_billing_suspended
  code?: string;
  message?: string;
}

// 优先用便宜的小模型探测；都不在列表里时取第一个
const PROBE_MODELS = ['deepseek/deepseek-v4-flash', 'qwen-turbo', 'deepseek-v3'];

// 发一个 max_tokens=1 的最小请求确认账户能调用模型；七牛先校验模型再校验计费，所以必须用真实模型
export async function checkAccountStatus(apiKey: string, baseUrl: string): Promise<AccountStatus> {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  try {
    const list = await fetch(`${baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(15000) });
    if (!list.ok) return { usable: false, code: `http_${list.status}` };
    const ids = ((await list.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
    const model = PROBE_MODELS.find((id) => ids.includes(id)) ?? ids[0];
    if (!model) return { usable: true };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30000),
    });
    if (response.ok) return { usable: true };
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    // 只把账户级错误视为不可用；模型临时不可用等不影响结论
    if (response.status === 401 || response.status === 403) {
      return { usable: false, code: body.error?.code ?? `http_${response.status}`, message: body.error?.message };
    }
    return { usable: true };
  } catch {
    // 网络问题交给连通性检查报告
    return { usable: true };
  }
}

// 账户不可用时给用户看的说明
export function describeAccountStatus(status: AccountStatus): string {
  if (status.code === 'account_billing_suspended') return t('account_billing_suspended');
  if (status.code === 'auth_api_key_invalid') return t('apikey_invalid', { error: status.message || '' });
  return t('account_unusable', { error: status.message || status.code || '' });
}
