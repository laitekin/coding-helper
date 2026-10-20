import { t } from '../../i18n.js';
import { configManager } from '../../config.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { uiRenderer } from '../ui/ui-renderer.js';
import { formatToolChoice, applyToolsWithProgress, renderResultSummary } from '../ui/tool-view.js';
import { stringWidth } from '../../../utils/string-width.js';
import { detectAllTools } from '../../core/tool-service.js';
import type { ITool } from '../../tools/base-tool.js';

// 多选客户端：默认勾选已安装的；返回用户选择的工具
export async function selectTools(message: string): Promise<ITool[]> {
  const detections = detectAllTools();
  const nameWidth = Math.max(...detections.map((d) => stringWidth(d.tool.displayName)));
  const selected = await promptHelper.checkbox<string>(
    message,
    detections.map((d) => ({
      name: formatToolChoice(d, nameWidth),
      value: d.tool.name,
      checked: d.installed === true,
    })),
  );
  return detections.filter((d) => selected.includes(d.tool.name)).map((d) => d.tool);
}

// 依次为选中的客户端配置模型，再统一装载并展示汇总
export async function setupTools(tools: ITool[]): Promise<void> {
  const ready: ITool[] = [];
  for (const tool of tools) {
    // 用户取消某个工具的模型配置时只跳过它，不影响其他工具
    if (await tool.runModelConfigFlow()) ready.push(tool);
  }
  if (ready.length === 0) return;

  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('setup_title'));
  if (!configManager.getApiKey()) {
    uiRenderer.renderWarning(t('apikey_not_set'));
    return;
  }
  const results = await applyToolsWithProgress(ready);
  renderResultSummary(results);
  await promptHelper.pressEnter();
}

// 初始化向导专用：多选工具 → 逐个配置模型 → 批量装载
export async function runToolSetupFlow(step?: { current: number; total: number }): Promise<void> {
  uiRenderer.renderHeader();
  if (step) uiRenderer.renderSteps(step.current, step.total, t('menu_configure_tools'));
  else uiRenderer.renderTitle(t('menu_configure_tools'));

  const tools = await selectTools(t('setup_select_tools'));
  if (tools.length === 0) {
    uiRenderer.renderHint(t('setup_none_selected'));
    return;
  }
  await setupTools(tools);
}
