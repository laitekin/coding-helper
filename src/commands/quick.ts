import ora, { type Ora } from 'ora';
import { t, i18n } from '../lib/i18n.js';
import { configManager } from '../lib/config.js';
import { DEFAULT_ENDPOINT, ENDPOINT_DEFINITIONS, getBaseUrl, otherEndpoint } from '../lib/endpoints.js';
import { validateApiKey, checkAccountStatus, describeAccountStatus } from '../lib/api-validator.js';
import { modelService } from '../lib/model-service.js';
import { marketModelService, getModelCapabilities } from '../lib/market-model-service.js';
import { toolManager } from '../lib/tool-manager.js';
import { applyTool, exitCodeFor, type ToolResult } from '../lib/core/tool-service.js';
import { getPlannedChanges, setDryRun } from '../lib/core/safe-write.js';
import { parseQuickArgs, pickApiKey, pickModel, type ModelSource } from '../lib/core/quick-args.js';
import { modelConfigFor, savedModelFor } from '../lib/core/model-mapping.js';
import type { ITool } from '../lib/tools/base-tool.js';
import { uiRenderer } from '../lib/wizard/ui/ui-renderer.js';
import { promptHelper } from '../lib/wizard/ui/prompt-helper.js';
import { theme } from '../lib/wizard/ui/theme.js';
import { renderPlannedChanges, renderResultSummary } from '../lib/wizard/ui/tool-view.js';
import { logger } from '../utils/logger.js';

export interface QuickOptions {
  intl?: boolean;
  dryRun?: boolean;
  json?: boolean;
  // commander 的 --no-save 生成 save: false
  save?: boolean;
}

// 写入前的校验失败：不改动任何文件，退出码 1
class QuickError extends Error {
  constructor(message: string, public readonly suggestions: string[] = []) {
    super(message);
  }
}

// 第一个位置参数是否走单条命令（工具名、别名、逗号分隔的多个工具或 all）
export function isQuickTarget(target: string): boolean {
  if (target === 'all') return true;
  return target.split(',').every((name) => !!toolManager.get(name.trim()));
}

// 工具最短的名字（claude-code → claude，minimax-code → mcode）
export function shortName(tool: ITool): string {
  return [tool.name, ...(tool.aliases ?? [])].sort((a, b) => a.length - b.length)[0];
}

function toolNames(): string {
  return toolManager.getAll().map(shortName).join(', ');
}

function resolveTools(names: string[] | 'all'): ITool[] {
  if (names === 'all') {
    // all：只配置本机已安装的（桌面应用无法检测，不包含）
    return toolManager.getAll().filter((tool) => tool.isInstalled() === true);
  }
  const unknown = names.filter((name) => !toolManager.get(name));
  if (unknown.length > 0) throw new QuickError(t('quick_unknown_tool', { tool: unknown.join(', '), tools: toolNames() }));
  return [...new Set(names.map((name) => toolManager.get(name) as ITool))];
}

// 启动方式：命令行工具给出命令，Copilot CLI 走 run，桌面应用提示手动打开
function launchHint(tool: ITool): string {
  if (tool.launchOnly) return `npx qiniu-coding-helper run ${tool.name}`;
  if (tool.isInstalled() === null) return t('quick_launch_desktop', { tool: tool.displayName });
  return tool.command;
}

// 普通模式下逐步打印进度；--json 模式下不输出，只在最后打印 JSON
function step(json: boolean, text: string): Ora | undefined {
  return json ? undefined : ora({ text, color: 'cyan' }).start();
}

// 单条命令：npx qiniu-coding-helper <工具[,工具…]|all> [API Key] [模型 ID]
export async function quickCommand(target: string, rest: string[], options: QuickOptions): Promise<void> {
  i18n.init();
  const json = !!options.json;
  const report: Record<string, unknown> = {};
  let spinner: Ora | undefined;

  try {
    // 1. 解析参数与工具
    let args;
    try {
      args = parseQuickArgs(target, rest);
    } catch {
      throw new QuickError(t('quick_duplicate_arg'));
    }
    const tools = resolveTools(args.tools);
    if (tools.length === 0) throw new QuickError(t('quick_no_installed'));

    // --no-save / --dry-run：Key、线路、模型只在本次进程内生效
    if (options.save === false || options.dryRun) configManager.useSessionOnly();

    // 2. 取得 Key：命令参数 → QINIU_API_KEY → 已保存 → 隐藏输入
    let picked = pickApiKey(args, process.env, configManager.getApiKey());
    if (!picked && !json && process.stdin.isTTY) {
      const entered = (await promptHelper.password(t('quick_key_prompt'))).trim();
      if (entered) picked = { key: entered, source: 'prompt' };
    }
    if (!picked) throw new QuickError(t('quick_no_key'));
    const apiKey = picked.key;
    report.keySource = picked.source;

    // 3. 校验 Key 与线路：首选线路返回 401 时换另一条再试一次
    spinner = step(json, t('quick_validating'));
    const preferred = options.intl
      ? 'international'
      : configManager.isFirstRun() ? DEFAULT_ENDPOINT : configManager.getEndpoint();
    let endpoint = preferred;
    let validation = await validateApiKey(apiKey, getBaseUrl(endpoint));
    let switched = false;
    if (!validation.valid && validation.error === 'Invalid API Key') {
      const other = otherEndpoint(preferred);
      const retry = await validateApiKey(apiKey, getBaseUrl(other));
      if (retry.valid) {
        endpoint = other;
        validation = retry;
        switched = true;
      }
    }
    if (!validation.valid) {
      throw new QuickError(validation.error === 'Invalid API Key'
        ? t('quick_key_invalid')
        : t('apikey_invalid', { error: validation.error || '' }));
    }
    const baseUrl = getBaseUrl(endpoint);
    configManager.setEndpoint(endpoint);
    configManager.setApiKey(apiKey);
    modelService.clearCache();
    marketModelService.clearCache();
    report.endpoint = endpoint;
    report.endpointSwitched = switched;

    // 4. 确认账户可用：欠费暂停时停止，配了也用不了
    const account = await checkAccountStatus(apiKey, baseUrl);
    if (!account.usable) throw new QuickError(describeAccountStatus(account));
    spinner?.succeed(t('quick_key_ok', { endpoint: t(ENDPOINT_DEFINITIONS[endpoint].i18nKey) }) +
      (switched ? t('quick_endpoint_switched') : ''));

    // 5. 确定模型：命令指定 → 已保存 → 按推荐列表自动选择；只选支持工具调用的模型
    spinner = step(json, t('hermes_fetching_models'));
    const available = (await modelService.fetchModels(baseUrl, apiKey)).map((m) => m.id);
    const toolCapable = new Set<string>();
    try {
      for (const m of await marketModelService.fetchModels(baseUrl, apiKey)) {
        if (getModelCapabilities(m).toolCall) toolCapable.add(m.id);
      }
    } catch {
      // 能力数据不可用时只校验模型是否存在
    }
    const saved = tools.length === 1 ? savedModelFor(tools[0], configManager.getModels()) : undefined;
    // 所有目标工具都能自行探测兼容性时（如 Codex 的 GPT 模型不在 /v1/models 中），指定的模型交给探测判断
    const probeOnly = !!args.model && !available.includes(args.model) && tools.every((tool) => !!tool.checkModel);
    const pick = probeOnly
      ? { model: args.model as string, source: 'argument' as const, corrected: undefined }
      : pickModel(args.model, saved, available, toolCapable);
    if ('error' in pick) {
      const list = pick.suggestions.join(', ');
      if (pick.error === 'not_available') {
        throw new QuickError(t('quick_model_not_available', { model: args.model ?? '' }) +
          (list ? t('quick_model_suggestions', { models: list }) : ''), pick.suggestions);
      }
      if (pick.error === 'no_tool_call') {
        throw new QuickError(t('quick_model_no_tool_call', { model: args.model ?? '', models: list }), pick.suggestions);
      }
      throw new QuickError(t('quick_model_none'));
    }
    // 6. 逐个工具确定模型：通用模型不兼容时（如 Codex 只支持 GPT），未指定模型的情况下改用该工具的默认模型；
    //    用户明确指定的模型不兼容时只跳过该工具
    const results: ToolResult[] = [];
    const writable: ITool[] = [];
    const toolModels: Record<string, string> = {};
    const savedModels = configManager.getModels();
    const ctx = { apiKey, baseUrl };
    for (const tool of tools) {
      let model: string | undefined;
      let reason: string | undefined;
      // 未指定模型时，能自行探测的工具（Codex）先试已保存或自己的默认模型，再试通用模型
      const tries = pick.source !== 'argument' && tool.checkModel
        ? [savedModelFor(tool, savedModels), tool.defaultModel, pick.model]
        : [pick.model];
      for (const candidate of [...new Set(tries.filter((m): m is string => !!m))]) {
        reason = await tool.checkModel?.(candidate, ctx);
        if (!reason) {
          model = candidate;
          break;
        }
      }
      if (!model) {
        results.push({ tool, status: 'skipped', reason });
        continue;
      }
      toolModels[tool.name] = model;
      configManager.setModels(modelConfigFor(tool, model));
      writable.push(tool);
    }

    // 只有一个工具时直接显示它实际使用的模型；多个工具时另列出例外
    const shown = tools.length === 1 && toolModels[tools[0].name] ? toolModels[tools[0].name] : pick.model;
    const source: ModelSource = shown === pick.model ? pick.source : 'tool_default';
    report.model = shown;
    report.modelSource = source;
    report.toolModels = toolModels;
    spinner?.succeed(t('quick_model_line', { model: shown, source: t(`quick_model_source_${source}`) }) +
      (pick.corrected ? `  ${theme.subtle(t('quick_model_corrected', { input: pick.corrected, model: pick.model }))}` : ''));
    spinner = undefined;
    if (!json && tools.length > 1) {
      for (const tool of writable) {
        if (toolModels[tool.name] !== pick.model) {
          logger.log(theme.subtle(`  ${t('quick_tool_model', { tool: tool.displayName, model: toolModels[tool.name] })}`));
        }
      }
    }

    // 7. 写入：复用 applyTool（备份、只改七牛条目、原子写入、记录原值）
    if (options.dryRun) setDryRun(true);
    for (const tool of writable) {
      // Copilot CLI 没有配置文件，保存模型后即可通过 run 使用
      if (tool.launchOnly) {
        results.push({ tool, status: 'success' });
        continue;
      }
      const s = tools.length === 1 ? step(json, t('setup_applying', { tool: tool.displayName })) : undefined;
      const result = await applyTool(tool);
      if (result.status === 'success') {
        s?.succeed(t(options.dryRun ? 'quick_planned' : 'quick_configured', { tool: tool.displayName }));
      } else {
        s?.stop();
      }
      results.push(result);
    }
    const changes = options.dryRun ? getPlannedChanges() : [];
    setDryRun(false);
    results.sort((a, b) => tools.indexOf(a.tool) - tools.indexOf(b.tool));

    // 8. 输出
    const succeeded = results.filter((r) => r.status === 'success');
    const exitCode = succeeded.length === 0 ? 1 : exitCodeFor(results);
    process.exitCode = exitCode;

    if (json) {
      const mask = (text?: string): string | undefined =>
        text ? text.split(apiKey).join(uiRenderer.maskApiKey(apiKey)) : text;
      console.log(JSON.stringify({
        ...report,
        results: results.map((r) => ({ tool: r.tool.name, status: r.status, reason: r.reason })),
        ...(options.dryRun ? { dryRun: true, changes: changes.map((c) => ({ file: c.file, before: mask(c.before), after: mask(c.after) })) } : {}),
        exitCode,
      }, null, 2));
      return;
    }

    if (tools.length > 1) {
      renderResultSummary(results);
    } else {
      for (const r of results.filter((x) => x.status !== 'success' || x.tool.launchOnly)) {
        if (r.status === 'success') logger.log(`${theme.success('✔')} ${t('quick_configured', { tool: r.tool.displayName })}`);
        else if (r.status === 'skipped') logger.log(`${theme.warning('–')} ${r.tool.displayName}：${t(r.reason ?? '')}`);
        else logger.log(`${theme.danger('✖')} ${r.tool.displayName}：${r.reason ?? ''}`);
      }
    }

    if (options.dryRun) {
      logger.newLine();
      renderPlannedChanges(changes, apiKey);
      return;
    }

    if (succeeded.length > 0) {
      logger.newLine();
      logger.log(t('quick_start_hint', { commands: succeeded.map((r) => theme.brandBold(launchHint(r.tool))).join('、') }));
      const restorable = succeeded.filter((r) => !r.tool.launchOnly).map((r) => shortName(r.tool));
      if (restorable.length > 0) {
        logger.log(theme.subtle(t('quick_undo_hint', { tools: restorable.join(',') })));
      }
      for (const r of succeeded) {
        if (r.tool.isInstalled() === false) {
          logger.log(theme.warning(t('quick_not_installed_hint', { tool: r.tool.displayName, command: r.tool.installCommand })));
        }
      }
    }
    if (picked.source === 'argument') logger.log(theme.subtle(t('quick_history_hint')));
  } catch (err: unknown) {
    setDryRun(false);
    const message = err instanceof Error ? err.message : String(err);
    process.exitCode = 1;
    if (json) {
      console.log(JSON.stringify({
        ...report,
        error: message,
        ...(err instanceof QuickError && err.suggestions.length > 0 ? { suggestions: err.suggestions } : {}),
        exitCode: 1,
      }, null, 2));
      return;
    }
    if (spinner) spinner.fail(message);
    else uiRenderer.renderError(message);
  }
}
