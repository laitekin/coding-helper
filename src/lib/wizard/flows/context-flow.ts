import { confirmAndWrite, selectTargets } from '../ui/write-plan.js';
import { configManager } from '../../config.js';
import { parseContextSize, formatContextSize } from '../../core/context.js';
import { getSyncTargets } from '../../core/tool-service.js';
import { toolManager } from '../../tool-manager.js';
import { t } from '../../i18n.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { uiRenderer } from '../ui/ui-renderer.js';
export const CONTEXT_UNSUPPORTED_TOOLS = ['claude-code', 'hermes', 'copilot'];
export function contextLabel(tokens?: number): string { return tokens ? formatContextSize(tokens) : t('context_auto'); }
export async function runContextFlow(): Promise<void> {
  const candidates = getSyncTargets(toolManager.getAll()).filter(tool => !CONTEXT_UNSUPPORTED_TOOLS.includes(tool.name));
  if (!candidates.length) {
    uiRenderer.renderHint(t('context_no_tools'));
    await promptHelper.pressEnter();
    return;
  }
  let context: number | undefined;
  while (true) {
    const input = await promptHelper.input(t('context_custom_prompt'));
    if (!input.trim()) return;
    try { context = parseContextSize(input); break; }
    catch { uiRenderer.renderError(t('context_invalid', { value: input })); }
  }
  const targets = await selectTargets(t('targets_prompt'), candidates);
  if (!targets?.length) return;
  await confirmAndWrite(t('context_title'), targets.map(tool => ({ tool, context: context ?? null, changes: [{ label: t('plan_context'), before: contextLabel(configManager.getContextWindow(tool.name)), after: contextLabel(context) }] })));
}

export function contextMenuHint(connected: string[]): string {
  const values = [...new Set(connected.filter(name => !CONTEXT_UNSUPPORTED_TOOLS.includes(name)).map(name => contextLabel(configManager.getContextWindow(name))))];
  return values.length > 1 ? t('context_mixed') : values[0] ?? contextLabel();
}
