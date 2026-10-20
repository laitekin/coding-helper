import { t } from '../../i18n.js';
import { configManager } from '../../config.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { uiRenderer } from '../ui/ui-renderer.js';
import { checkPrompt } from '../ui/prompts.js';
import { applyToolsWithProgress, renderResultSummary, toolIcon } from '../ui/tool-view.js';
import { detectAllTools } from '../../core/tool-service.js';
import { runModelPickFlow } from './model-pick-flow.js';
import type { ITool } from '../../tools/base-tool.js';
import { theme } from '../ui/theme.js';

// 多选客户端：默认勾选已安装的；返回用户选择的工具
export async function selectTools(message: string): Promise<ITool[]> {
  const detections = detectAllTools().filter((d) => !d.tool.launchOnly);
  // 已安装的排在前面
  detections.sort((a, b) => Number(b.installed !== false) - Number(a.installed !== false));
  const selected = await checkPrompt<string>({
    message,
    items: detections.map((d) => {
      const installed = d.installed !== false;
      return {
        value: d.tool.name,
        label: d.tool.displayName,
        icon: toolIcon(d.tool.name, !installed),
        tag: d.installed === null ? t('tool_badge_desktop') : installed ? t('tool_badge_installed') : t('tool_badge_not_installed'),
        checked: d.installed === true,
        preferred: installed,
      };
    }),
    summary: (values) => values.length
      ? `${theme.brand('i')} ${theme.value(t('setup_preview', { count: String(values.length) }))} ${theme.subtle('~/.coding-helper/backups/')}`
      : theme.subtle(t('setup_none_selected')),
    footer: [['space', t('ui_key_toggle')], ['a', t('ui_key_select_all')], ['n', t('ui_key_select_none')], ['i', t('ui_key_invert')], ['⏎', t('ui_key_next')]],
  });
  return detections.filter((d) => selected.includes(d.tool.name)).map((d) => d.tool);
}

// 选模型（统一选或按工具分别选），再统一装载并展示结果
export async function setupTools(tools: ITool[], step?: { current: number; total: number }): Promise<void> {
  if (!configManager.getApiKey()) {
    uiRenderer.renderWarning(t('apikey_not_set'));
    return;
  }
  let ready: ITool[] = [];
  const pick = await runModelPickFlow(tools.filter((tool) => !tool.launchOnly), step);
  if (pick === 'cancelled') return;
  if (pick === 'saved') ready = tools;
  else {
    // 用户取消某个工具的模型配置时只跳过它，不影响其他工具
    for (const tool of tools) {
      if (await tool.runModelConfigFlow()) ready.push(tool);
    }
  }
  if (ready.length === 0) return;

  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('setup_title'));
  const results = await applyToolsWithProgress(ready);
  renderResultSummary(results);
  await promptHelper.pressEnter();
}

// 初始化向导：第 4 步多选工具 → 第 5 步选模型 → 批量装载
export async function runToolSetupFlow(step?: { current: number; total: number }): Promise<void> {
  uiRenderer.renderHeader();
  if (step) uiRenderer.renderSteps(step.current, step.total);
  else uiRenderer.renderTitle(t('menu_configure_tools'));

  const tools = await selectTools(t('setup_select_tools'));
  if (tools.length === 0) {
    uiRenderer.renderHint(t('setup_none_selected'));
    return;
  }
  await setupTools(tools, step ? { current: step.current + 1, total: step.total } : undefined);
}
