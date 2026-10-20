import { t } from '../../i18n.js';
import { configManager } from '../../config.js';
import { uiRenderer } from '../ui/ui-renderer.js';
import { menuPrompt } from '../ui/prompts.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { syncAfterChange } from '../ui/tool-view.js';
import { formatContextSize, parseContextSize } from '../../core/quick-args.js';
import { toolManager } from '../../tool-manager.js';
import { logger } from '../../../utils/logger.js';
import { theme } from '../ui/theme.js';

// 不能设置上下文大小的工具（由工具自己管理）
export const CONTEXT_UNSUPPORTED_TOOLS = ['claude-code', 'hermes', 'copilot'];

const PRESETS = [128000, 64000, 32000];

export function contextLabel(tokens = configManager.getContextWindow()): string {
  return tokens ? formatContextSize(tokens) : t('context_auto');
}

// 上下文大小：自动（模型上限）/ 预设 / 自定义；修改后同步到已接入的工具
export async function runContextFlow(): Promise<void> {
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('context_title'));
  uiRenderer.renderHint(t('context_hint'));
  const unsupported = toolManager.getAll().filter((tool) => CONTEXT_UNSUPPORTED_TOOLS.includes(tool.name));
  uiRenderer.renderHint(t('context_unsupported', { tools: unsupported.map((tool) => tool.displayName).join('、') }));
  logger.newLine();

  const current = configManager.getContextWindow();
  const { value, action } = await menuPrompt<number | 'custom' | 0>({
    message: t('context_prompt'),
    default: current && PRESETS.includes(current) ? current : current ? 'custom' : 0,
    escape: true,
    items: [
      { value: 0, key: '1', label: t('context_auto'), hint: t('context_auto_hint') },
      ...PRESETS.map((tokens, i) => ({ value: tokens, key: String(i + 2), label: formatContextSize(tokens), hint: t(`context_hint_${tokens}`) })),
      { value: 'custom' as const, key: 'c', label: t('context_custom'), hint: current && !PRESETS.includes(current) ? formatContextSize(current) : t('context_custom_hint') },
    ],
    footer: [['↑↓', t('ui_key_move')], ['⏎', t('ui_key_confirm')], ['c', t('context_custom')], ['esc', t('ui_key_back')]],
  });
  if (action === 'escape') return;

  let tokens: number | undefined = value === 0 ? undefined : value === 'custom' ? undefined : value;
  if (value === 'custom') {
    const input = await promptHelper.input(t('context_custom_prompt'), current ? formatContextSize(current) : '');
    try {
      tokens = parseContextSize(input);
    } catch {
      uiRenderer.renderError(t('context_invalid', { value: input }));
      await promptHelper.pressEnter();
      return;
    }
  }
  if (tokens === current) return;

  configManager.setContextWindow(tokens);
  uiRenderer.renderSuccess(t('context_saved', { value: contextLabel(tokens) }));
  logger.log(`  ${theme.subtle(t('context_capped_hint'))}`);
  await syncAfterChange('sync_start_generic');
  await promptHelper.pressEnter();
}
