import os from 'node:os';
import chalk from 'chalk';
import { t } from '../../i18n.js';
import { configManager, type ModelConfig } from '../../config.js';
import { applyTool, type ToolResult } from '../../core/tool-service.js';
import { getPlannedChanges, setDryRun, type PlannedChange } from '../../core/safe-write.js';
import type { ITool } from '../../tools/base-tool.js';
import { logger } from '../../../utils/logger.js';
import { padVisible, visibleWidth } from '../../../utils/string-width.js';
import { theme } from './theme.js';
import { uiRenderer } from './ui-renderer.js';
import { checkPrompt, menuPrompt, type KeyHint } from './prompts.js';
import { promptHelper } from './prompt-helper.js';
import { applyToolsWithProgress, renderPlannedChanges, renderResultSummary, toolIcon } from './tool-view.js';

// 写入计划里的一项改动：标签、原值、新值
export interface PlanChange {
  label: string;
  before?: string;
  after: string;
}

// 一个工具要写入的内容：要保存的模型 / 上下文，以及展示给用户的改动
export interface PlanItem {
  tool: ITool;
  models?: ModelConfig;
  // undefined：不改；null：改回自动（模型上限）
  context?: number | null;
  changes: PlanChange[];
}

// 工具的配置文件路径（展示用）
export function toolConfigPath(tool: ITool): string | undefined {
  try {
    const config = tool.getConfig();
    for (const key of ['configPath', 'settingsPath', 'configFile', 'path']) {
      if (typeof config[key] === 'string') return (config[key] as string).replace(os.homedir(), '~');
    }
  } catch {
    // 读不到配置时不显示路径
  }
  return undefined;
}

// 勾选要处理的工具：列表右侧显示 detail（如当前模型）；preselect 为默认勾选的工具名
export async function selectTargets(
  message: string,
  tools: ITool[],
  options: { preselect?: string[]; detail?: (tool: ITool) => string; footer?: KeyHint[] } = {},
): Promise<ITool[]> {
  if (tools.length === 0) return [];
  const width = Math.max(...tools.map((tool) => visibleWidth(tool.displayName)));
  const values = await checkPrompt<string>({
    message,
    columns: 1,
    items: tools.map((tool) => ({
      value: tool.name,
      label: padVisible(tool.displayName, width),
      icon: toolIcon(tool.name),
      tag: options.detail?.(tool),
      checked: options.preselect?.includes(tool.name) ?? false,
      preferred: true,
    })),
    summary: (picked) => picked.length
      ? theme.value(t('targets_summary', { count: String(picked.length), total: String(tools.length) }))
      : theme.subtle(t('targets_none')),
    footer: options.footer ?? [['space', t('ui_key_toggle')], ['a', t('ui_key_select_all_short')], ['n', t('ui_key_select_none')], ['⏎', t('ui_key_next')]],
  });
  return tools.filter((tool) => values.includes(tool.name));
}

// 把计划里的模型与上下文保存到 coding-helper 配置
function saveSettings(items: PlanItem[]): void {
  for (const item of items) {
    if (item.models) configManager.setModels(item.models);
    if (item.context !== undefined) configManager.setContextWindow(item.context ?? undefined, [item.tool.name]);
  }
}

// 预演写入：临时保存设置、只记录不写盘，得到每个工具会改的文件，然后恢复设置
async function dryRunPlan(items: PlanItem[]): Promise<Map<ITool, PlannedChange[]>> {
  const snapshot = configManager.snapshotToolSettings();
  const result = new Map<ITool, PlannedChange[]>();
  saveSettings(items);
  try {
    for (const item of items) {
      setDryRun(true);
      try {
        await applyTool(item.tool);
        result.set(item.tool, getPlannedChanges());
      } finally {
        setDryRun(false);
      }
    }
  } finally {
    configManager.restoreToolSettings(snapshot);
  }
  return result;
}

function renderPlan(title: string, items: PlanItem[], untouched: ITool[], files: Map<ITool, PlannedChange[]>): void {
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(title, t('plan_subtitle', { count: String(items.length) }));
  const nameWidth = Math.max(...items.map((item) => visibleWidth(item.tool.displayName)));
  const labelWidth = Math.max(4, ...items.flatMap((item) => item.changes.map((c) => visibleWidth(c.label))), visibleWidth(t('plan_file')));
  for (const item of items) {
    const rows: [string, string][] = item.changes.map((c) => [
      c.label,
      c.before && c.before !== c.after
        ? `${theme.subtle(c.before)} ${theme.subtle('→')} ${chalk.hex('#8BE9FF')(c.after)}`
        : `${chalk.hex('#8BE9FF')(c.after)}${c.before === c.after ? theme.subtle(`  ${t('plan_unchanged')}`) : ''}`,
    ]);
    const changed = files.get(item.tool) ?? [];
    const paths = changed.length ? changed.map((c) => c.file.replace(os.homedir(), '~')) : [toolConfigPath(item.tool)].filter((f): f is string => !!f);
    paths.forEach((file, i) => rows.push([i === 0 ? t('plan_file') : '', theme.subtle(file)]));
    rows.forEach(([label, value], i) => {
      const head = i === 0 ? `${toolIcon(item.tool.name)} ${theme.value(padVisible(item.tool.displayName, nameWidth))}` : ' '.repeat(nameWidth + 2);
      logger.log(`  ${head}   ${theme.subtle(padVisible(label, labelWidth))}  ${value}`);
    });
    logger.newLine();
  }
  if (untouched.length) {
    logger.log(`  ${theme.subtle(t('plan_untouched', { tools: untouched.map((tool) => tool.displayName).join(' · ') }))}`);
  }
  logger.log(`  ${theme.subtle(t('plan_backup'))}`);
  logger.newLine();
}

// 查看具体改动：逐个文件展示差异（Key 打码）
async function showDiff(files: Map<ITool, PlannedChange[]>): Promise<void> {
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('plan_diff_title'));
  renderPlannedChanges([...files.values()].flat(), configManager.getApiKey(), { footer: false });
  await promptHelper.pressEnter(t('plan_diff_back'));
}

// 确认页：列出每个工具将要改的内容和不会动的工具；⏎ 写入 · d 查看具体改动 · esc 取消
// 确认后保存设置并写入，返回结果；取消返回 undefined
export async function confirmAndWrite(title: string, items: PlanItem[], untouched: ITool[] = []): Promise<ToolResult[] | undefined> {
  if (items.length === 0) return undefined;
  const files = await dryRunPlan(items);
  while (true) {
    renderPlan(title, items, untouched, files);
    const { value, action } = await menuPrompt<'write' | 'diff' | 'cancel'>({
      message: t('plan_prompt'),
      escape: true,
      items: [
        { value: 'write', key: 'y', label: t('plan_write', { count: String(items.length) }) },
        { value: 'diff', key: 'd', label: t('plan_view_diff') },
        { value: 'cancel', key: 'q', label: t('plan_cancel') },
      ],
      footer: [['y', t('plan_key_write')], ['d', t('plan_key_diff')], ['esc', t('plan_cancel')]],
    });
    if (action === 'escape' || value === 'cancel') return undefined;
    if (value === 'diff') {
      await showDiff(files);
      continue;
    }
    saveSettings(items);
    uiRenderer.renderHeader();
    uiRenderer.renderTitle(title);
    const results = await applyToolsWithProgress(items.map((item) => item.tool));
    // 写入后重画页头，状态行显示最新接入数
    uiRenderer.renderHeader();
    uiRenderer.renderTitle(title);
    renderResultSummary(results);
    return results;
  }
}
