import ora from 'ora';
import { t } from '../../i18n.js';
import { configManager, type ModelConfig } from '../../config.js';
import { marketModelService, getModelCapabilities, type MarketModelInfo } from '../../market-model-service.js';
import { RECOMMENDED_MODELS, formatContextSize } from '../../core/quick-args.js';
import { modelConfigFor, savedModelFor } from '../../core/model-mapping.js';
import type { ITool } from '../../tools/base-tool.js';
import { uiRenderer } from '../ui/ui-renderer.js';
import { menuPrompt, type MenuItem } from '../ui/prompts.js';
import type { PlanChange, PlanItem } from '../ui/write-plan.js';
import { theme } from '../ui/theme.js';
import { logger } from '../../../utils/logger.js';
import { contextLabel } from './context-flow.js';

const PER_TOOL = '__per_tool__';

export type ModelChoice = { model: string } | 'per_tool' | 'cancelled';

function modelRow(m: MarketModelInfo, current: string | undefined, tools: ITool[]): MenuItem<string> {
  const caps = getModelCapabilities(m);
  const tags = [
    RECOMMENDED_MODELS.includes(m.id) ? theme.success(t('model_tag_recommended')) : '',
    m.id === current ? theme.brand(t('model_tag_current')) : '',
    caps.toolCall ? '' : theme.warning(t('model_tag_no_tool_call')),
  ].filter(Boolean).join(' ');
  const checks = tools.filter((tool) => tool.checkModel).map((tool) => tool.displayName);
  const description = [
    theme.subtle(`${m.id.split('/')[0]} · ${t('model_context', { size: formatContextSize(caps.maxInputTokens) })} · ${caps.toolCall ? t('model_tool_call_yes') : t('model_tool_call_no')}`),
    checks.length ? theme.subtle(t('model_probe_hint', { tools: checks.join('、') })) : '',
  ].filter(Boolean).join('\n');
  return { value: m.id, label: m.id, hint: `${theme.subtle(formatContextSize(caps.maxInputTokens).padStart(5))}  ${tags}`, description, search: m.name };
}

// 推荐模型在前，其余按名称
function sortModels(models: MarketModelInfo[]): MarketModelInfo[] {
  const rank = (id: string): number => {
    const i = RECOMMENDED_MODELS.indexOf(id);
    return i === -1 ? RECOMMENDED_MODELS.length : i;
  };
  return [...models].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

// 为这些工具选一个模型（只选，不保存）；返回 per_tool 表示改为按工具分别选
export async function chooseModel(tools: ITool[], step?: { current: number; total: number }): Promise<ModelChoice> {
  const apiKey = configManager.getApiKey();
  if (!apiKey) {
    uiRenderer.renderError(t('apikey_not_set'));
    return 'cancelled';
  }

  uiRenderer.renderHeader();
  if (step) uiRenderer.renderSteps(step.current, step.total, t('model_pick_title'));
  const spinner = ora({ text: t('hermes_fetching_models'), indent: 2 }).start();
  let models: MarketModelInfo[];
  try {
    models = await marketModelService.fetchModels(configManager.baseUrl, apiKey);
    spinner.stop();
  } catch (error: unknown) {
    spinner.fail(t('hermes_fetch_models_failed', { error: error instanceof Error ? error.message : t('error_unknown') }));
    return 'cancelled';
  }

  const current = configManager.getModels().defaultModel ?? (tools[0] ? savedModelFor(tools[0], configManager.getModels()) : undefined);
  let showAll = false;
  while (true) {
    uiRenderer.renderHeader();
    if (step) uiRenderer.renderSteps(step.current, step.total, t('model_pick_title'));
    else uiRenderer.renderTitle(t('model_pick_title'));
    const usable = models.filter((m) => showAll || getModelCapabilities(m).toolCall);
    logger.log(`  ${theme.subtle(t('model_pick_summary', {
      tools: tools.map((tool) => tool.displayName).join(' · '),
      count: String(usable.length),
      filter: showAll ? t('model_filter_all') : t('model_filter_tool_call'),
      context: contextLabel(),
    }))}`);
    logger.newLine();

    const { value, action, query } = await menuPrompt<string>({
      message: t('model_pick_prompt'),
      default: current,
      escape: true,
      searchable: true,
      actions: ['t'],
      pageSize: 12,
      customLabel: (q) => t('model_custom_value', { value: q }),
      items: [
        ...sortModels(usable).map((m) => modelRow(m, current, tools)),
        ...(tools.length > 1 ? [{ separator: '' }, { value: PER_TOOL, key: 'p', label: t('model_per_tool'), hint: t('model_per_tool_hint') }] : []),
      ],
      footer: [['↑↓', t('ui_key_move')], ['/', t('ui_key_search')], ['t', showAll ? t('model_key_tool_call_only') : t('model_key_show_all')], ...(tools.length > 1 ? [['p', t('model_per_tool')] as [string, string]] : []), ['⏎', t('ui_key_confirm')], ['esc', t('ui_key_back')]],
    });
    if (action === 'escape') return 'cancelled';
    if (action === 't') {
      showAll = !showAll;
      continue;
    }
    if (value === PER_TOOL) return 'per_tool';
    const model = action === 'custom' ? query!.trim() : value;
    if (!model) continue;
    return { model };
  }
}

function claudeSlots(models: ModelConfig): { main?: string; fallback?: string } {
  const c = models.claudeCode;
  return { main: c?.sonnetModel, fallback: c?.haikuModel };
}

// 为每个工具生成写入计划：Codex 等先检测兼容性，不兼容时改用它自己的默认模型；
// Claude Code 的主模型（Sonnet · Opus）与兜底模型（Haiku · Subagent）一起切换
export async function buildModelPlan(tools: ITool[], model: string): Promise<PlanItem[]> {
  const apiKey = configManager.getApiKey()!;
  const baseUrl = configManager.baseUrl;
  const saved = configManager.getModels();
  const items: PlanItem[] = [];
  logger.newLine();
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
    const changes: PlanChange[] = tool.name === 'claude-code'
      ? [
          { label: t('plan_claude_main'), before: claudeSlots(saved).main, after: chosen },
          { label: t('plan_claude_fallback'), before: claudeSlots(saved).fallback, after: chosen },
        ]
      : [{ label: t('plan_model'), before: tool.isConfigured() ? savedModelFor(tool, saved) ?? tool.defaultModel : undefined, after: note ? `${chosen}  ${theme.subtle(note)}` : chosen }];
    items.push({ tool, models: modelConfigFor(tool, chosen), changes });
  }
  // 只在第一次记下默认模型（供之后的菜单默认选中），不会拿它去改其他工具
  if (!saved.defaultModel) configManager.setModels({ defaultModel: model });
  return items;
}
