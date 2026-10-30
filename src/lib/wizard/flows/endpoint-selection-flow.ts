import { t } from '../../i18n.js';
import { configManager } from '../../config.js';
import { CUSTOM_ENDPOINT, ENDPOINT_DEFINITIONS, normalizeCustomBaseUrl } from '../../endpoints.js';
import { uiRenderer } from '../ui/ui-renderer.js';
import { menuPrompt, textPrompt } from '../ui/prompts.js';
import { modelService } from '../../model-service.js';
import { marketModelService } from '../../market-model-service.js';
import { syncAfterChange } from './sync-tools-flow.js';

export async function pickEndpoint(): Promise<[string, string | undefined] | undefined> {
  const { value, action } = await menuPrompt({ message: t('endpoint_prompt'), escape: true, default: configManager.getEndpoint(), items: [
    ...Object.entries(ENDPOINT_DEFINITIONS).map(([id, definition]) => ({ value: id, label: t(definition.i18nKey) })),
    { value: CUSTOM_ENDPOINT, label: t('endpoint_custom_option') },
  ] });
  if (action === 'escape') return undefined;
  if (value !== CUSTOM_ENDPOINT) return [value, undefined];
  const input = await textPrompt({ message: t('endpoint_custom_prompt') });
  if (!input?.trim()) return undefined;
  try { return [CUSTOM_ENDPOINT, normalizeCustomBaseUrl(input)]; }
  catch { uiRenderer.renderError(t('endpoint_custom_invalid', { value: '' })); return undefined; }
}
export async function runEndpointSelectionFlow(): Promise<boolean> {
  uiRenderer.renderHeader();
  const previous = configManager.baseUrl;
  const picked = await pickEndpoint();
  if (!picked) return false;
  configManager.setEndpoint(...picked);
  modelService.clearCache(); marketModelService.clearCache();
  uiRenderer.renderSuccess(t('endpoint_set', { endpoint: configManager.baseUrl }));
  if (previous !== configManager.baseUrl) await syncAfterChange();
  return true;
}
