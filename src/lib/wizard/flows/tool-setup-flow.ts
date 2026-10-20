import { t } from '../../i18n.js';
import { configManager } from '../../config.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { uiRenderer } from '../ui/ui-renderer.js';
import { checkPrompt } from '../ui/prompts.js';
import { toolIcon } from '../ui/tool-view.js';
import { detectAllTools } from '../../core/tool-service.js';
import { chooseModel, buildModelPlan } from './model-pick-flow.js';
import { confirmAndWrite, type PlanItem } from '../ui/write-plan.js';
import { savedModelFor } from '../../core/model-mapping.js';
import { toolManager } from '../../tool-manager.js';
import { connectedToolNames } from '../ui/ui-renderer.js';
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
        // 默认不勾选：只改用户明确选择的工具（a 一键全选已安装）
        checked: false,
        preferred: installed,
      };
    }),
    summary: (values) => values.length
      ? `${theme.brand('i')} ${theme.value(t('setup_preview', { count: String(values.length) }))} ${theme.subtle('~/.coding-helper/backups/')}`
      : theme.subtle(t('setup_none_hint')),
    footer: [['space', t('ui_key_toggle')], ['a', t('ui_key_select_all')], ['n', t('ui_key_select_none')], ['i', t('ui_key_invert')], ['⏎', t('ui_key_next')]],
  });
  return detections.filter((d) => selected.includes(d.tool.name)).map((d) => d.tool);
}

// 选模型（统一选或按工具分别选）→ 确认页 → 只写入选中的工具
export async function setupTools(tools: ITool[], step?: { current: number; total: number }, title = t('setup_title')): Promise<void> {
  if (!configManager.getApiKey()) {
    uiRenderer.renderWarning(t('apikey_not_set'));
    return;
  }
  const targets = tools.filter((tool) => !tool.launchOnly);
  const choice = await chooseModel(targets, step);
  if (choice === 'cancelled') return;

  let items: PlanItem[];
  if (choice === 'per_tool') {
    items = [];
    // 按工具分别选：各工具自己的流程（如 Claude Code 的 4 个模型槽位），取消的只跳过它
    for (const tool of targets) {
      if (!(await tool.runModelConfigFlow())) continue;
      const model = savedModelFor(tool, configManager.getModels()) ?? tool.defaultModel ?? '';
      items.push({ tool, changes: [{ label: t('plan_model'), after: model }] });
    }
  } else {
    items = await buildModelPlan(targets, choice.model);
  }
  const chosen = new Set(items.map((item) => item.tool.name));
  const untouched = toolManager.getAll().filter((tool) => connectedToolNames().includes(tool.name) && !chosen.has(tool.name));
  const results = await confirmAndWrite(title, items, untouched);
  if (results) await promptHelper.pressEnter();
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
