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
import { uiRenderer, type StepInfo } from './ui-renderer.js';
import { checkPrompt, menuPrompt, type MenuEntry } from './prompts.js';
import { promptHelper } from './prompt-helper.js';
import { applyToolsWithProgress, renderPlannedChanges, renderResultSummary, toolIcon } from './tool-view.js';

// 写入计划里的一项改动：标签、原值、新值，以及附注（如「跟随主模型」）
export interface PlanChange {
  label: string;
  before?: string;
  after: string;
  note?: string;
}

// 一个工具要写入的内容：要保存的模型 / 上下文，以及展示给用户的改动
export interface PlanItem {
  tool: ITool;
  models?: ModelConfig;
  // undefined：不改；null：改回自动（模型上限）
  context?: number | null;
  changes: PlanChange[];
  // 模型计划：主模型与单独设置的槽位（确认页里可以再调整）
  main?: string;
  overrides?: Record<string, string>;
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
// 按 Esc 返回 undefined
export async function selectTargets(
  message: string,
  tools: ITool[],
  options: { preselect?: string[]; detail?: (tool: ITool) => string; allowEmpty?: boolean; nextLabel?: string } = {},
): Promise<ITool[] | undefined> {
  if (tools.length === 0) return [];
  const width = Math.max(...tools.map((tool) => visibleWidth(tool.displayName)));
  const values = await checkPrompt<string>({
    message,
    allowEmpty: options.allowEmpty,
    nextLabel: options.nextLabel,
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
  });
  if (!values) return undefined;
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

// 一项改动的显示：原值 → 新值 · 附注
function changeText(c: PlanChange): string {
  const after = chalk.hex('#8BE9FF')(c.after);
  const value = c.before && c.before !== c.after ? `${theme.subtle(c.before)} ${theme.subtle('→')} ${after}` : after;
  const note = c.note ?? (c.before === c.after ? t('plan_unchanged') : '');
  return note ? `${value}  ${theme.subtle(note)}` : value;
}

// 收起时一行的摘要：主模型的变化，以及其余几项的情况
function itemSummary(item: PlanItem): string {
  const [first, ...rest] = item.changes;
  if (!first) return '';
  const following = rest.filter((c) => c.note === t('slot_following')).length;
  const own = rest.filter((c) => c.note === t('slot_kept') || c.note === t('slot_custom')).length;
  const extra = [
    following ? t('plan_more_following', { count: String(following) }) : '',
    own ? t('plan_more_own', { count: String(own) }) : '',
    rest.length - following - own > 0 ? t('plan_more_changes', { count: String(rest.length - following - own) }) : '',
  ].filter(Boolean).join(' · ');
  return `${changeText({ ...first, note: first.note })}${extra ? theme.subtle(`  ${extra}`) : ''}`;
}

function changedFiles(item: PlanItem, files: Map<ITool, PlannedChange[]>): string[] {
  const changed = files.get(item.tool) ?? [];
  return changed.length ? changed.map((c) => c.file.replace(os.homedir(), '~')) : [toolConfigPath(item.tool)].filter((f): f is string => !!f);
}

// 查看具体改动：逐个文件展示差异（Key 打码）
async function showDiff(files: Map<ITool, PlannedChange[]>): Promise<void> {
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('plan_diff_title'));
  renderPlannedChanges([...files.values()].flat(), configManager.getApiKey(), { footer: false });
  await promptHelper.pressEnter(t('plan_diff_back'));
}

export interface ConfirmOptions {
  step?: StepInfo;
  // 在确认页里调整某个工具（如模型槽位）；返回新的计划，undefined 表示不变
  edit?: (item: PlanItem) => Promise<PlanItem | undefined>;
}

const WRITE = '__write__';
const DIFF = '__diff__';

// 确认页：每个工具一行，→ 展开查看每一项和会改的文件，回车调整该工具；
// 「写入 N 个工具」后保存设置并写入，返回结果；Esc 返回上一步（'back'）
export async function confirmAndWrite(
  title: string,
  items: PlanItem[],
  untouched: ITool[] = [],
  options: ConfirmOptions = {},
): Promise<ToolResult[] | 'back'> {
  if (items.length === 0) return 'back';
  let files = await dryRunPlan(items);
  const expanded = new Set<string>(items.length === 1 ? [items[0].tool.name] : []);
  let last: string = WRITE;
  while (true) {
    uiRenderer.renderPage(title, options.step, t('plan_subtitle', { count: String(items.length) }));
    const entries: MenuEntry<string>[] = [];
    const nameWidth = Math.max(...items.map((item) => visibleWidth(item.tool.displayName)));
    for (const item of items) {
      const open = expanded.has(item.tool.name);
      entries.push({
        value: item.tool.name,
        icon: toolIcon(item.tool.name),
        label: `${padVisible(item.tool.displayName, nameWidth)} ${theme.subtle(open ? '▾' : '▸')}`,
        hint: open ? '' : itemSummary(item),
        description: theme.subtle(options.edit ? t('plan_row_hint_edit') : t('plan_row_hint')),
      });
      if (!open) continue;
      const rows: [string, string][] = item.changes.map((c) => [c.label, changeText(c)]);
      changedFiles(item, files).forEach((file, i) => rows.push([i === 0 ? t('plan_file') : '', theme.subtle(file)]));
      for (const [label, value] of rows) {
        entries.push({ value: `${item.tool.name}:${label}`, label: `   ${label}`, hint: value, disabled: true });
      }
      entries.push({ separator: '' });
    }
    if (entries.length && !('separator' in entries[entries.length - 1])) entries.push({ separator: '' });
    entries.push(
      { value: WRITE, label: theme.brandBold(t('plan_write', { count: String(items.length) })) },
      { value: DIFF, label: t('plan_view_diff') },
    );
    if (untouched.length) logger.log(`  ${theme.subtle(t('plan_untouched', { tools: untouched.map((tool) => tool.displayName).join(' · ') }))}`);
    logger.log(`  ${theme.subtle(t('plan_backup'))}`);
    logger.newLine();

    const { value, action } = await menuPrompt<string>({
      message: t('plan_prompt'),
      default: last,
      escape: true,
      arrows: true,
      pageSize: 20,
      items: entries,
      footer: [['↑↓', t('ui_key_move')], ['→', t('plan_key_expand')], [t('ui_key_enter'), t('ui_key_confirm')], ['Esc', t('ui_key_back')]],
    });
    if (action === 'escape') return 'back';
    last = value;
    const item = items.find((x) => x.tool.name === value);
    if (item) {
      if (action === 'right') expanded.add(value);
      else if (action === 'left') expanded.delete(value);
      else if (options.edit) {
        const next = await options.edit(item);
        if (next) {
          items[items.indexOf(item)] = next;
          files = await dryRunPlan(items);
          expanded.add(value);
        }
      } else if (expanded.has(value)) expanded.delete(value);
      else expanded.add(value);
      continue;
    }
    if (action === 'left' || action === 'right') continue;
    if (value === DIFF) {
      await showDiff(files);
      continue;
    }
    saveSettings(items);
    uiRenderer.renderPage(title, options.step);
    const results = await applyToolsWithProgress(items.map((x) => x.tool));
    // 写入后重画页头，状态行显示最新接入数
    uiRenderer.renderPage(title, options.step ? { ...options.step, current: options.step.total + 1 } : undefined);
    renderResultSummary(results);
    return results;
  }
}
