import { t } from '../../i18n.js';
import { configManager } from '../../config.js';
import { CUSTOM_ENDPOINT, ENDPOINT_DEFINITIONS } from '../../endpoints.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { uiRenderer, type StepInfo } from '../ui/ui-renderer.js';
import { menuPrompt } from '../ui/prompts.js';
import { modelService } from '../../model-service.js';
import { marketModelService } from '../../market-model-service.js';
import { syncAfterChange } from '../ui/tool-view.js';

// 自定义地址：http(s) 开头，去掉末尾斜杠
export function normalizeCustomBaseUrl(input: string): string | undefined {
  const url = input.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

// 选择线路：国内 / 海外 / 自定义；返回 [线路 id, 自定义地址]，取消时返回 undefined
export async function pickEndpoint(current?: string, currentBaseUrl?: string): Promise<[string, string | undefined] | undefined> {
  const { value, action } = await menuPrompt<string>({
    message: t('endpoint_prompt'),
    default: current,
    escape: true,
    items: [
      ...Object.entries(ENDPOINT_DEFINITIONS).map(([id, def]) => ({ value: id, label: t(def.i18nKey) })),
      { value: CUSTOM_ENDPOINT, label: t('endpoint_custom_option'), hint: current === CUSTOM_ENDPOINT ? currentBaseUrl : t('endpoint_custom_hint') },
    ],
  });
  if (action === 'escape') return undefined;
  if (value !== CUSTOM_ENDPOINT) return [value, undefined];

  while (true) {
    const input = await promptHelper.input(t('endpoint_custom_prompt'), current === CUSTOM_ENDPOINT ? currentBaseUrl : '');
    if (!input.trim()) return undefined;
    const url = normalizeCustomBaseUrl(input);
    if (url) return [CUSTOM_ENDPOINT, url];
    uiRenderer.renderError(t('endpoint_custom_invalid', { value: input }));
  }
}

// 线路选择流程；step 用于首次向导的进度展示。选好返回 true，Esc 返回 false
export async function runEndpointSelectionFlow(step?: StepInfo): Promise<boolean> {
  uiRenderer.renderPage(t('menu_configure_endpoint'), step);
  const previous = configManager.getEndpoint();
  const previousUrl = configManager.baseUrl;

  const picked = await pickEndpoint(previous, previousUrl);
  if (!picked) return false;
  const [endpoint, customUrl] = picked;

  configManager.setEndpoint(endpoint, customUrl);
  // 切换线路后清除模型缓存
  modelService.clearCache();
  marketModelService.clearCache();
  uiRenderer.renderSuccess(t('endpoint_set', { endpoint: uiRenderer.endpointLabel() }));

  // 线路变化后同步到已接入的客户端
  if (!step && configManager.baseUrl !== previousUrl && configManager.getApiKey()) {
    const results = await syncAfterChange();
    if (results.length > 0) await promptHelper.pressEnter(t('result_back_to_menu'));
  }
  return true;
}
