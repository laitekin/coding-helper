import { t } from '../../i18n.js';
import { configManager } from '../../config.js';
import { uiRenderer } from '../ui/ui-renderer.js';
import { menuPrompt } from '../ui/prompts.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { connectedToolNames } from '../ui/ui-renderer.js';
import { confirmAndWrite, selectTargets, type PlanItem } from '../ui/write-plan.js';
import type { ITool } from '../../tools/base-tool.js';
import { formatContextSize, parseContextSize } from '../../core/quick-args.js';
import { toolManager } from '../../tool-manager.js';
import { logger } from '../../../utils/logger.js';

// 不能设置上下文大小的工具（由工具自己管理）
export const CONTEXT_UNSUPPORTED_TOOLS = ['claude-code', 'hermes', 'copilot'];

const PRESETS = [128000, 64000, 32000];

export function contextLabel(tokens = configManager.getContextWindow()): string {
  return tokens ? formatContextSize(tokens) : t('context_auto');
}

// 某个工具的上下文显示值
function toolContextLabel(tool: ITool): string {
  return contextLabel(configManager.getContextWindow(tool.name));
}

// 已接入工具的上下文：都相同时显示该值，不同时显示「各不相同」
export function contextMenuHint(connected: string[]): string {
  const tools = toolManager.getAll().filter((tool) => connected.includes(tool.name) && !CONTEXT_UNSUPPORTED_TOOLS.includes(tool.name));
  const values = [...new Set(tools.map((tool) => toolContextLabel(tool)))];
  if (values.length === 1) return values[0];
  if (values.length > 1) return t('context_mixed');
  return contextLabel(undefined);
}

// 上下文大小：选大小 → 勾选要应用的工具（默认不勾）→ 确认页 → 只写入选中的工具
export async function runContextFlow(): Promise<void> {
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('context_title'), t('context_hint'));
  const unsupported = toolManager.getAll().filter((tool) => CONTEXT_UNSUPPORTED_TOOLS.includes(tool.name));
  uiRenderer.renderHint(t('context_unsupported', { tools: unsupported.map((tool) => tool.displayName).join('、') }));
  logger.newLine();

  const { value, action } = await menuPrompt<number | 'custom' | 0>({
    message: t('context_prompt'),
    escape: true,
    items: [
      { value: 0, label: t('context_auto'), hint: t('context_auto_hint') },
      ...PRESETS.map((tokens) => ({ value: tokens, label: formatContextSize(tokens), hint: t(`context_hint_${tokens}`) })),
      { value: 'custom' as const, label: t('context_custom'), hint: t('context_custom_hint') },
    ],
  });
  if (action === 'escape') return;

  let tokens: number | undefined = typeof value === 'number' && value > 0 ? value : undefined;
  if (value === 'custom') {
    const input = await promptHelper.input(t('context_custom_prompt'));
    // 留空或 Esc 视为取消
    if (!input) return;
    try {
      tokens = parseContextSize(input);
    } catch {
      uiRenderer.renderError(t('context_invalid', { value: input }));
      await promptHelper.pressEnter();
      return;
    }
  }

  const connected = connectedToolNames();
  const candidates = toolManager.getAll().filter((tool) => connected.includes(tool.name) && !CONTEXT_UNSUPPORTED_TOOLS.includes(tool.name));
  if (candidates.length === 0) {
    uiRenderer.renderHint(t('context_no_tools'));
    await promptHelper.pressEnter();
    return;
  }
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('context_title'), t('context_targets_hint', { value: contextLabel(tokens) }));
  const targets = await selectTargets(t('targets_prompt'), candidates, { detail: (tool) => t('context_current', { value: toolContextLabel(tool) }) });
  if (!targets || targets.length === 0) return;

  const items: PlanItem[] = targets.map((tool) => ({
    tool,
    context: tokens ?? null,
    changes: [{ label: t('plan_context'), before: toolContextLabel(tool), after: contextLabel(tokens) }],
  }));
  const untouched = toolManager.getAll().filter((tool) => connected.includes(tool.name) && !targets.includes(tool));
  const results = await confirmAndWrite(t('context_title'), items, untouched);
  if (results !== 'back') await promptHelper.pressEnter(t('result_back_to_menu'));
}
