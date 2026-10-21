import ora from 'ora';
import { t } from '../../i18n.js';
import { configManager, type ModelConfig } from '../../config.js';
import { marketModelService, getModelCapabilities, type MarketModelInfo } from '../../market-model-service.js';
import { RECOMMENDED_MODELS, formatContextSize } from '../../core/quick-args.js';
import { modelConfigFor, savedModelFor } from '../../core/model-mapping.js';
import { closestModels, parseModelQuery, resolveModelId, scoreModel, vendorOf, VENDORS } from '../../core/model-search.js';
import { slotOverrides, toolSlots } from '../../core/model-slots.js';
import type { ITool } from '../../tools/base-tool.js';
import { uiRenderer, type StepInfo } from '../ui/ui-renderer.js';
import { menuPrompt, type MenuEntry, type MenuItem } from '../ui/prompts.js';
import type { PlanChange, PlanItem } from '../ui/write-plan.js';
import { claudeSelectedModel } from '../../tools/claude-code-tool.js';
import { theme } from '../ui/theme.js';
import { logger } from '../../../utils/logger.js';

const FOLLOW = '__follow__';
const SHOW_ALL = '__show_all__';

export type PickResult = { model: string } | { follow: true } | 'back';

export interface PickOptions {
  // 用来显示兼容性的工具
  tools: ITool[];
  title?: string;
  step?: StepInfo;
  // 默认选中的模型
  current?: string;
  // 设置槽位时传入主模型：第一行显示「跟随主模型」
  follow?: string;
}

let cachedModels: MarketModelInfo[] | undefined;

// 取模型列表（同一进程内只取一次；换 Key / 线路时 marketModelService 会清缓存）
async function loadModels(): Promise<MarketModelInfo[] | undefined> {
  const apiKey = configManager.getApiKey();
  if (!apiKey) {
    uiRenderer.renderError(t('apikey_not_set'));
    return undefined;
  }
  const spinner = ora({ text: t('hermes_fetching_models'), indent: 2 }).start();
  try {
    cachedModels = await marketModelService.fetchModels(configManager.baseUrl, apiKey);
    spinner.stop();
    return cachedModels;
  } catch (error: unknown) {
    spinner.fail(t('hermes_fetch_models_failed', { error: error instanceof Error ? error.message : t('error_unknown') }));
    return cachedModels;
  }
}

// 某个工具能否用这个模型：工具自己的预判优先，其次看是否支持工具调用
function supports(tool: ITool, m: MarketModelInfo): boolean | undefined {
  if (!getModelCapabilities(m).toolCall) return false;
  return tool.modelSupport ? tool.modelSupport(m.id) : true;
}

// 选中行下方：厂商 · 上下文 · 能力，以及每个工具能否使用
function describe(m: MarketModelInfo, tools: ITool[]): string {
  const caps = getModelCapabilities(m);
  const vendor = VENDORS.find((v) => v.id === vendorOf(m.id))?.label ?? m.id.split('/')[0];
  const info = [
    vendor,
    t('model_context', { size: formatContextSize(caps.maxInputTokens) }),
    caps.toolCall ? t('model_tool_call_yes') : t('model_tool_call_no'),
    ...(caps.images ? [t('model_vision')] : []),
  ].join(' · ');
  const compat = tools.map((tool) => {
    const ok = supports(tool, m);
    if (ok === true) return `${theme.success('✔')} ${theme.value(tool.displayName)}`;
    if (ok === false) return `${theme.danger('✖')} ${theme.subtle(tool.displayName)}`;
    return `${theme.warning('?')} ${theme.subtle(`${tool.displayName} ${t('model_check_later')}`)}`;
  }).join('  ');
  return [theme.subtle(info), compat].filter(Boolean).join('\n');
}

function modelRow(m: MarketModelInfo, options: PickOptions, extra: Partial<MenuItem<string>> = {}): MenuItem<string> {
  const caps = getModelCapabilities(m);
  const blocked = options.tools.filter((tool) => supports(tool, m) === false);
  const tags = [
    RECOMMENDED_MODELS.includes(m.id) ? theme.success(t('model_tag_recommended')) : '',
    m.id === options.current ? theme.brand(t('model_tag_current')) : '',
    !caps.toolCall ? theme.warning(t('model_tag_no_tool_call')) : blocked.length ? theme.warning(`✖ ${blocked.map((tool) => tool.displayName).join(' ')}`) : '',
  ].filter(Boolean).join(' ');
  return {
    value: m.id,
    label: m.id,
    hint: `${theme.subtle(formatContextSize(caps.maxInputTokens).padStart(5))}  ${tags}`,
    description: describe(m, options.tools),
    search: m.name,
    ...extra,
  };
}

// 推荐模型在前，其余按名称
function sortModels(models: MarketModelInfo[]): MarketModelInfo[] {
  const rank = (id: string): number => {
    const i = RECOMMENDED_MODELS.indexOf(id);
    return i === -1 ? RECOMMENDED_MODELS.length : i;
  };
  return [...models].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

// 选模型：直接打字搜索，←→ 切换厂商，默认只列支持工具调用的模型；Esc 返回上一步
export async function pickModel(options: PickOptions): Promise<PickResult> {
  const title = options.title ?? t('model_pick_title');
  uiRenderer.renderPage(title, options.step);
  const models = cachedModels ?? await loadModels();
  if (!models) return 'back';

  let showAll = false;
  let last: string | undefined = options.current;
  while (true) {
    uiRenderer.renderPage(title, options.step);
    const usable = sortModels(models.filter((m) => showAll || getModelCapabilities(m).toolCall));
    const byId = new Map(models.map((m) => [m.id, m]));
    const recent = (configManager.getModels().recentModels ?? []).filter((id) => usable.some((m) => m.id === id));
    logger.log(`  ${theme.subtle(t('model_pick_summary', {
      tools: options.tools.map((tool) => tool.displayName).join(' · '),
      count: String(usable.length),
      filter: showAll ? t('model_filter_all') : t('model_filter_tool_call'),
    }))}`);
    logger.newLine();

    const items: MenuEntry<string>[] = [
      ...(options.follow ? [{ value: FOLLOW, label: t('slot_follow_main'), hint: theme.subtle(options.follow) }, { separator: '' }] : []),
      ...(recent.length ? [
        { separator: theme.subtle(t('model_section_recent')) },
        ...recent.map((id) => modelRow(byId.get(id)!, options, { pinned: true })),
        { separator: theme.subtle(t('model_section_all')) },
      ] : []),
      ...usable.map((m) => modelRow(m, options)),
      { separator: '' },
      { value: SHOW_ALL, label: showAll ? t('model_show_tool_call_only') : t('model_show_all', { count: String(models.length) }) },
    ];

    const { value, action, query } = await menuPrompt<string>({
      message: options.follow ? t('slot_pick_prompt') : t('model_pick_prompt'),
      default: last,
      escape: true,
      searchable: true,
      pageSize: 12,
      items,
      tabs: [
        { label: t('model_tab_all'), match: () => true },
        ...VENDORS.map((v) => ({ label: v.label, match: (item: MenuItem<string>) => item.value === SHOW_ALL || vendorOf(item.value) === v.id })),
      ],
      filter: (item, q) => {
        const m = byId.get(item.value);
        if (!m) return undefined;
        const caps = getModelCapabilities(m);
        return scoreModel({ id: m.id, context: caps.maxInputTokens, toolCall: caps.toolCall, vision: caps.images }, q, {
          recommended: RECOMMENDED_MODELS.includes(m.id),
          recent: recent.includes(m.id),
        });
      },
      highlight: (q) => parseModelQuery(q).words.join(''),
      emptyText: (q) => t('model_search_none', { query: q }),
      suggest: (q) => closestModels(usable.map((m) => m.id), q).map((id) => modelRow(byId.get(id)!, options)),
      customLabel: (q) => t('model_custom_value', { value: resolveModelId(q, models.map((m) => m.id)) }),
    });
    if (action === 'escape') return 'back';
    if (value === SHOW_ALL) {
      showAll = !showAll;
      last = SHOW_ALL;
      continue;
    }
    if (value === FOLLOW) return { follow: true };
    const model = action === 'custom' ? resolveModelId(query ?? '', models.map((m) => m.id)) : value;
    if (!model) continue;
    configManager.rememberModel(model);
    return { model };
  }
}

// ─── 写入计划 ─────────────────────────────────────────────────────

// 主模型一项的显示名
function mainLabel(tool: ITool): string {
  return tool.name === 'claude-code' ? t('plan_claude_main') : t('plan_model');
}

// 工具当前的主模型（未接入时为空）
export function currentMainModel(tool: ITool, models: ModelConfig = configManager.getModels()): string | undefined {
  return tool.isConfigured() ? savedModelFor(tool, models) ?? tool.defaultModel : undefined;
}

// 一个工具的写入计划：主模型 + 各槽位（单独设置过的保持不变，其余跟随主模型）
export function planForTool(tool: ITool, main: string, overrides: Record<string, string> = slotOverrides(tool.name), note = ''): PlanItem {
  const saved = configManager.getModels();
  const before = currentMainModel(tool, saved);
  const previous = slotOverrides(tool.name, saved);
  const changes: PlanChange[] = [{ label: mainLabel(tool), before, after: main, note }];
  for (const slot of toolSlots(tool.name)) {
    const own = overrides[slot.id];
    const was = before ? previous[slot.id] ?? before : undefined;
    changes.push(own
      ? { label: t(slot.labelKey), before: was, after: own, note: own === previous[slot.id] ? t('slot_kept') : t('slot_custom') }
      : { label: t(slot.labelKey), before: was, after: main, note: t('slot_following') });
  }
  // Claude Code 的 /model 选择会盖过上面几项，一并改回跟随主模型
  if (tool.name === 'claude-code' && claudeSelectedModel()) {
    changes.push({ label: t('plan_claude_selected'), before: claudeSelectedModel(), after: t('plan_claude_follow_main') });
  }
  const withSlots: ModelConfig = { slotModels: { [tool.name]: overrides } };
  return {
    tool,
    models: { ...modelConfigFor(tool, main, withSlots), slotModels: { [tool.name]: overrides } },
    changes,
    main,
    overrides,
  };
}

// 为每个工具生成写入计划：Codex 等先检测兼容性，不兼容时改用它自己的默认模型
export async function buildModelPlan(tools: ITool[], model: string): Promise<PlanItem[]> {
  const apiKey = configManager.getApiKey()!;
  const baseUrl = configManager.baseUrl;
  const items: PlanItem[] = [];
  const checks = tools.filter((tool) => tool.checkModel);
  if (checks.length) logger.newLine();
  for (const tool of tools) {
    let chosen = model;
    let note = '';
    if (tool.checkModel) {
      const spinner = ora({ text: t('model_checking', { tool: tool.displayName, model }), indent: 2 }).start();
      const reason = await tool.checkModel(model, { apiKey, baseUrl });
      if (reason && tool.defaultModel) {
        chosen = tool.defaultModel;
        note = t('plan_model_fallback_note', { model });
        spinner.warn(t('model_fallback', { tool: tool.displayName, model, fallback: chosen }));
      } else if (reason) {
        spinner.fail(t(reason, { tool: tool.displayName, model }));
        continue;
      } else {
        spinner.succeed(t('model_compatible', { tool: tool.displayName, model }));
      }
    }
    items.push(planForTool(tool, chosen, undefined, note));
  }
  // 只在第一次记下默认模型（供之后的菜单默认选中），不会拿它去改其他工具
  if (!configManager.getModels().defaultModel) configManager.setModels({ defaultModel: model });
  return items;
}
