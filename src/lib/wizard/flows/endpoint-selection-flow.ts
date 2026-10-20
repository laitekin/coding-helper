import { t } from '../../i18n.js';
import { configManager } from '../../config.js';
import { ENDPOINT_DEFINITIONS } from '../../endpoints.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { uiRenderer } from '../ui/ui-renderer.js';
import { modelService } from '../../model-service.js';
import { syncAfterChange } from '../ui/tool-view.js';

// 线路选择流程；step 用于首次向导的进度展示
export async function runEndpointSelectionFlow(step?: { current: number; total: number }): Promise<void> {
  uiRenderer.renderHeader();
  if (step) uiRenderer.renderSteps(step.current, step.total, t('menu_configure_endpoint'));
  const previous = configManager.getEndpoint();
  const choices = Object.entries(ENDPOINT_DEFINITIONS).map(([id, def]) => ({
    name: t(def.i18nKey),
    value: id,
  }));

  const endpoint = await promptHelper.select<string>(t('endpoint_prompt'), choices);

  configManager.setEndpoint(endpoint);
  // 切换线路后清除模型缓存
  modelService.clearCache();
  uiRenderer.renderSuccess(t('endpoint_set', { endpoint: t(ENDPOINT_DEFINITIONS[endpoint].i18nKey) }));

  // 线路变化后同步到已接入的客户端（F4）
  if (!step && endpoint !== previous && configManager.getApiKey()) {
    const results = await syncAfterChange();
    if (results.length > 0) await promptHelper.pressEnter();
  }
}
