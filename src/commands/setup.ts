import ora from 'ora';
import { t, i18n } from '../lib/i18n.js';
import { configManager } from '../lib/config.js';
import { validateApiKey, checkAccountStatus, describeAccountStatus } from '../lib/api-validator.js';
import { modelService } from '../lib/model-service.js';
import { marketModelService } from '../lib/market-model-service.js';
import { toolManager } from '../lib/tool-manager.js';
import { uiRenderer } from '../lib/wizard/ui/ui-renderer.js';
import { selectTools } from '../lib/wizard/flows/tool-setup-flow.js';
import { applyToolsWithProgress, renderPlannedChanges, renderResultSummary } from '../lib/wizard/ui/tool-view.js';
import { getPlannedChanges, setDryRun } from '../lib/core/safe-write.js';
import {
  applyTool,
  detectAllTools,
  exitCodeFor,
  hasSavedToolModelConfig,
  type ToolResult,
} from '../lib/core/tool-service.js';
import type { ITool } from '../lib/tools/base-tool.js';
import { logger } from '../utils/logger.js';

export interface SetupOptions {
  tools?: string;
  yes?: boolean;
  json?: boolean;
  keyStdin?: boolean;
  dryRun?: boolean;
}

// 从标准输入读取 API Key，避免明文出现在命令行与 shell 历史中
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8').trim();
}

// 解析 --tools，支持别名；未知名称直接报错
function resolveTools(list: string): ITool[] {
  const names = list.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !toolManager.get(name));
  if (unknown.length > 0) {
    throw new Error(t('auth_unknown_tool', { tool: unknown.join(', ') }));
  }
  return [...new Set(names.map((name) => toolManager.get(name) as ITool))];
}

function toJson(results: ToolResult[]): object {
  return {
    results: results.map((r) => ({ tool: r.tool.name, status: r.status, reason: r.reason })),
    exitCode: exitCodeFor(results),
  };
}

// setup 命令：批量把七牛配置写入本机的编码工具
export async function setupCommand(options: SetupOptions): Promise<void> {
  i18n.init();
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !options.yes && !options.json;
  const quiet = !!options.json;

  try {
    // 1. API Key：--key-stdin 优先，否则使用已保存的 Key
    if (options.keyStdin) {
      const key = await readStdin();
      if (!key) throw new Error(t('apikey_empty'));
      const result = await validateApiKey(key, configManager.baseUrl);
      if (!result.valid) throw new Error(t('apikey_invalid', { error: result.error || '' }));
      // 预演模式不保存 Key
      if (options.dryRun) configManager.useApiKeyForSession(key);
      else configManager.setApiKey(key);
      modelService.clearCache();
      marketModelService.clearCache();
    }
    if (!configManager.getApiKey()) throw new Error(t('setup_apikey_missing'));

    if (!quiet) {
      uiRenderer.renderLogo();
      uiRenderer.renderTitle(t('setup_title'));
    }

    // 账户不可用（如欠费暂停）时提前提醒；配置照常写入，充值后即可使用
    const account = await checkAccountStatus(configManager.getApiKey() as string, configManager.baseUrl);
    if (!account.usable && !quiet) {
      uiRenderer.renderWarning(describeAccountStatus(account));
      logger.newLine();
    }

    // 2. 选择客户端
    const explicit = options.tools ? resolveTools(options.tools) : undefined;
    let targets: ITool[];
    const skipped: ToolResult[] = [];
    if (explicit) {
      targets = explicit;
    } else if (interactive) {
      targets = (await selectTools(t('setup_select_tools'))) ?? [];
    } else {
      // 非交互：配置所有已安装的；未安装或无法检测的记为跳过
      targets = [];
      for (const detection of detectAllTools()) {
        if (detection.installed === true) targets.push(detection.tool);
        else skipped.push({
          tool: detection.tool,
          status: 'skipped',
          reason: detection.installed === null ? 'setup_reason_desktop' : 'setup_reason_not_installed',
        });
      }
    }

    // 3. 交互模式下，为必须选模型但还没选的工具补一次模型选择
    if (interactive && !options.dryRun) {
      for (const tool of targets) {
        if (tool.requiresModelSelection && !hasSavedToolModelConfig(tool, configManager.getModels())) {
          await tool.runModelConfigFlow();
        }
      }
    }

    if (targets.length === 0 && !quiet) {
      uiRenderer.renderHint(t('setup_none_selected'));
    }

    // 4. 装载并汇总（预演模式下只记录变更，不写盘）
    if (options.dryRun) setDryRun(true);
    let applied: ToolResult[];
    if (quiet) {
      applied = [];
      for (const tool of targets) applied.push(await applyTool(tool));
    } else {
      applied = await applyToolsWithProgress(targets);
    }
    const results = [...applied, ...skipped];

    if (options.dryRun) {
      const changes = getPlannedChanges();
      setDryRun(false);
      if (quiet) {
        const mask = (text?: string): string | undefined => {
          const key = configManager.getApiKey();
          return text && key ? text.split(key).join(uiRenderer.maskApiKey(key)) : text;
        };
        console.log(JSON.stringify({
          ...toJson(results),
          dryRun: true,
          changes: changes.map((c) => ({ file: c.file, before: mask(c.before), after: mask(c.after) })),
        }, null, 2));
      } else {
        renderResultSummary(results);
        renderPlannedChanges(changes, configManager.getApiKey());
      }
    } else if (quiet) {
      console.log(JSON.stringify({ ...toJson(results), account }, null, 2));
    } else {
      renderResultSummary(results);
      if (results.some((r) => r.status === 'success')) uiRenderer.renderHint(t('setup_restore_hint'));
    }
    process.exitCode = exitCodeFor(applied);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (quiet) console.log(JSON.stringify({ error: message, exitCode: 1 }, null, 2));
    else uiRenderer.renderError(message);
    process.exitCode = 1;
  }
}

// status 命令：读各客户端实际配置文件，展示接入状态
export async function statusCommand(options: { json?: boolean }): Promise<void> {
  i18n.init();
  const detections = detectAllTools();
  if (options.json) {
    console.log(JSON.stringify({
      endpoint: configManager.getEndpoint(),
      baseUrl: configManager.baseUrl,
      apiKeySet: !!configManager.getApiKey(),
      tools: detections.map((d) => ({
        tool: d.tool.name,
        installed: d.installed,
        version: d.version,
        configured: d.configured,
      })),
    }, null, 2));
    return;
  }

  const { formatInstallState, formatConfiguredBadge } = await import('../lib/wizard/ui/tool-view.js');
  uiRenderer.renderTitle(t('status_title'));
  const apiKey = configManager.getApiKey();
  uiRenderer.renderConfigItem(t('config_view_endpoint'), configManager.baseUrl);
  uiRenderer.renderConfigItem(t('config_view_apikey'), apiKey ? uiRenderer.maskApiKey(apiKey) : t('config_view_not_set'));
  logger.newLine();
  uiRenderer.renderTable(
    [t('setup_col_tool'), t('status_col_installed'), t('status_col_configured')],
    detections.map((d) => [d.tool.displayName, formatInstallState(d), formatConfiguredBadge(d)]),
  );
  logger.newLine();
}

// restore 命令：移除七牛配置，并把被覆盖的原值写回
export async function restoreCommand(tool: string | undefined, options: { yes?: boolean }): Promise<void> {
  i18n.init();
  const { getRestoreTargets, removeTool } = await import('../lib/core/tool-service.js');
  const { promptHelper } = await import('../lib/wizard/ui/prompt-helper.js');

  let targets: ITool[];
  try {
    targets = tool ? resolveTools(tool) : getRestoreTargets();
  } catch (err: unknown) {
    uiRenderer.renderError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (targets.length === 0) {
    uiRenderer.renderHint(t('restore_nothing'));
    return;
  }

  uiRenderer.renderTitle(t('restore_title'));
  const names = targets.map((target) => target.displayName).join(', ');
  if (process.stdin.isTTY && !options.yes) {
    const confirmed = await promptHelper.confirm(t('restore_confirm', { tools: names }), false);
    if (!confirmed) return;
  }

  const results: ToolResult[] = [];
  for (const target of targets) {
    const spinner = ora({ text: target.displayName, color: 'cyan', indent: 2 }).start();
    const result = await removeTool(target);
    if (result.status === 'success') spinner.succeed(t('tool_config_unloaded', { tool: target.displayName }));
    else spinner.fail(`${target.displayName} ${result.reason ?? ''}`);
    results.push(result);
  }
  renderResultSummary(results, { restore: true });
  process.exitCode = exitCodeFor(results);
}
