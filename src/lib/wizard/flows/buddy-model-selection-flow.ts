import { configManager, type Connection } from '../../config.js';
import { getModelCapabilities } from '../../market-model-service.js';
import { t } from '../../i18n.js';
import { uiRenderer, type StepInfo } from '../ui/ui-renderer.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { textPrompt } from '../ui/prompts.js';
import { loadModelCatalog } from './model-catalog-flow.js';

export interface BuddyModelOptions { connection?: Connection; previous?: string[]; step?: StepInfo; }

// 能力目录失败时仍可通过标准目录或手动输入继续；取消始终交回上层处理。
export async function selectBuddyModels(tool: 'codebuddy' | 'workbuddy', options: BuddyModelOptions): Promise<string[] | null> {
  const connection = options.connection ?? configManager.getConnection(tool);
  if (!connection.apiKey) { uiRenderer.renderError(t('apikey_not_set')); return null; }
  const title = t(`${tool}_select_models`);
  if (options.previous?.length) {
    uiRenderer.renderPage(title, options.step, undefined, connection);
    uiRenderer.renderHint(t(`${tool}_current_models`, { models: options.previous.join(', ') }));
    if (await promptHelper.confirm(t(`${tool}_reuse_previous_selection`), true)) return [...options.previous];
  }
  while (true) {
    const catalog = await loadModelCatalog(connection, title, options.step);
    if (catalog.kind === 'back') return null;
    uiRenderer.renderPage(title, options.step, undefined, connection);
    if (catalog.kind === 'manual') {
      uiRenderer.renderHint(t('model_info_unknown'));
      const value = await textPrompt({ message: t('model_manual_multiple') });
      if (value === undefined) continue;
      const selected = [...new Set(value.split(/[,，\s]+/).filter(Boolean))];
      if (selected.length) return selected;
      uiRenderer.renderWarning(t(`${tool}_no_models_selected`));
      continue;
    }
    if (catalog.models.some(model => 'capabilitiesUnknown' in model)) uiRenderer.renderHint(t('model_info_unknown'));
    const choices = catalog.models.map(model => {
      const tags: string[] = [];
      if (!('capabilitiesUnknown' in model)) {
        const caps = getModelCapabilities(model);
        if (caps.toolCall) tags.push(t('codebuddy_model_tag_tool_call'));
        if (caps.images) tags.push(t('codebuddy_model_tag_images'));
        if (caps.reasoning) tags.push(t('codebuddy_model_tag_reasoning'));
      }
      return { name: `${model.name}${tags.length ? ' ' + tags.join(' ') : ''}`, value: model.id };
    });
    const selected = await promptHelper.checkbox(title, choices, { allowEmpty: false });
    return selected?.length ? selected : null;
  }
}
