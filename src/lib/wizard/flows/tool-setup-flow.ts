import { t } from '../../i18n.js';
import { configManager } from '../../config.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { uiRenderer, connectedToolNames, FLOW_STEP_KEYS, type StepInfo } from '../ui/ui-renderer.js';
import { checkPrompt } from '../ui/prompts.js';
import { toolIcon } from '../ui/tool-view.js';
import { detectAllTools } from '../../core/tool-service.js';
import { buildModelPlan, currentMainModel, pickModel } from './model-pick-flow.js';
import { editToolModels } from './model-slots-flow.js';
import { confirmAndWrite, selectTargets } from '../ui/write-plan.js';
import { toolManager } from '../../tool-manager.js';
import type { ITool } from '../../tools/base-tool.js';
import { theme } from '../ui/theme.js';

// 多选客户端：已安装的在前，默认一个不勾；返回用户选择的工具，按 Esc 返回 undefined
export async function selectTools(message: string): Promise<ITool[] | undefined> {
  const detections = detectAllTools().filter((d) => !d.tool.launchOnly);
  detections.sort((a, b) => Number(b.installed !== false) - Number(a.installed !== false));
  const selected = await checkPrompt<string>({
    message,
    allLabel: t('ui_check_all_installed'),
    items: detections.map((d) => {
      const installed = d.installed !== false;
      return {
        value: d.tool.name,
        label: d.tool.displayName,
        icon: toolIcon(d.tool.name, !installed),
        tag: d.installed === null ? t('tool_badge_desktop') : installed ? t('tool_badge_installed') : t('tool_badge_not_installed'),
        checked: false,
        // 第一行「全选已安装」只选这些
        preferred: installed,
      };
    }),
    summary: (values) => values.length
      ? `${theme.brand('i')} ${theme.value(t('setup_preview', { count: String(values.length) }))} ${theme.subtle('~/.coding-helper/backups/')}`
      : theme.subtle(t('setup_none_hint')),
  });
  if (!selected) return undefined;
  return detections.filter((d) => selected.includes(d.tool.name)).map((d) => d.tool);
}

export interface FlowSteps {
  // 第一步（选工具）在整个流程中的序号
  first: number;
  total: number;
  keys: string[];
}

const FLOW_STEPS: FlowSteps = { first: 1, total: FLOW_STEP_KEYS.length, keys: FLOW_STEP_KEYS };

// 选工具 → 选模型 → 确认写入；每一步 Esc 回到上一步，第一步 Esc 返回 'back'
export async function toolsModelFlow(
  title: string,
  select: (step: StepInfo) => Promise<ITool[] | undefined>,
  steps: FlowSteps = FLOW_STEPS,
): Promise<'back' | 'done'> {
  const at = (offset: number): StepInfo => ({ current: steps.first + offset, total: steps.total, keys: steps.keys });
  let stage = 0;
  let tools: ITool[] = [];
  let model = '';
  while (true) {
    if (stage === 0) {
      uiRenderer.renderPage(title, at(0));
      const picked = await select(at(0));
      if (!picked || picked.length === 0) return 'back';
      tools = picked.filter((tool) => !tool.launchOnly);
      stage = 1;
      continue;
    }
    if (stage === 1) {
      const saved = configManager.getModels();
      const current = model || (tools[0] ? currentMainModel(tools[0], saved) : undefined) || saved.defaultModel;
      const picked = await pickModel({ tools, title, step: at(1), current });
      if (picked === 'back' || !('model' in picked)) {
        stage = 0;
        continue;
      }
      model = picked.model;
      stage = 2;
      continue;
    }
    const items = await buildModelPlan(tools, model);
    const chosen = new Set(items.map((item) => item.tool.name));
    const untouched = toolManager.getAll().filter((tool) => connectedToolNames().includes(tool.name) && !chosen.has(tool.name));
    const results = await confirmAndWrite(title, items, untouched, {
      step: at(2),
      edit: (item) => editToolModels(item.tool, item),
    });
    if (results === 'back') {
      stage = 1;
      continue;
    }
    await promptHelper.pressEnter(t('result_back_to_menu'));
    return 'done';
  }
}

// 接入编码工具：勾选工具（全部工具，已安装的在前）→ 选模型 → 确认
export async function runSetupFlow(steps?: FlowSteps): Promise<'back' | 'done'> {
  if (!configManager.getApiKey()) {
    uiRenderer.renderWarning(t('apikey_not_set'));
    await promptHelper.pressEnter();
    return 'back';
  }
  return toolsModelFlow(t('menu_setup_tools'), () => selectTools(t('setup_select_tools')), steps);
}

// 切换模型：只列已接入的工具
export async function runSwitchModelFlow(): Promise<void> {
  const connected = connectedToolNames();
  const tools = toolManager.getAll().filter((tool) => connected.includes(tool.name) && !tool.launchOnly);
  if (tools.length === 0) {
    uiRenderer.renderPage(t('menu_switch_model'));
    uiRenderer.renderHint(t('menu_switch_model_none'));
    await promptHelper.pressEnter();
    return;
  }
  const models = configManager.getModels();
  await toolsModelFlow(t('menu_switch_model'), () => selectTargets(t('targets_prompt'), tools, {
    detail: (tool) => currentMainModel(tool, models) ?? '—',
  }));
}

// 单个工具的模型页 → 确认写入（工具菜单用）；确认页 Esc 回到模型页
export async function runToolModelFlow(tool: ITool): Promise<void> {
  let item = await editToolModels(tool);
  while (item) {
    const results = await confirmAndWrite(t('slots_title', { tool: tool.displayName }), [item], [], {
      edit: (current) => editToolModels(current.tool, current),
    });
    if (results !== 'back') {
      await promptHelper.pressEnter(t('result_back_to_menu'));
      return;
    }
    item = await editToolModels(tool, item);
  }
}
