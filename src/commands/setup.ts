import { configManager, type Connection } from '../lib/config.js';
import { i18n, t } from '../lib/i18n.js';
import { validateApiKey, checkAccountStatus, describeAccountStatus, type AccountStatus } from '../lib/api-validator.js';
import { toolManager } from '../lib/tool-manager.js';
import { modelService } from '../lib/model-service.js';
import { marketModelService } from '../lib/market-model-service.js';
import { applyTool, exitCodeFor, hasSavedToolModelConfig, type ToolResult } from '../lib/core/tool-service.js';
import { savedModelFor } from '../lib/core/model-mapping.js';
import type { ITool } from '../lib/tools/base-tool.js';
import { promptHelper } from '../lib/wizard/ui/prompt-helper.js';
import { uiRenderer } from '../lib/wizard/ui/ui-renderer.js';
import { jsonToolResults, renderToolResults } from '../lib/wizard/ui/tool-results.js';
import { withQuietLogs } from '../utils/logger.js';
import { previewWrites, publicPlannedChanges } from '../lib/core/safe-write.js';

export interface SetupOptions { tools?: string; yes?: boolean; json?: boolean; keyStdin?: boolean; dryRun?: boolean; }

export async function setupCommand(options: SetupOptions): Promise<void> {
  try {
    i18n.init();
    const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !options.yes && !options.json && !options.keyStdin;
    let targets: ITool[] = [];
    const skipped: ToolResult[] = [];
    if (options.tools !== undefined) {
      const names = options.tools.split(',').map(name => name.trim()).filter(Boolean);
      if (!names.length) throw new Error('No tool names provided');
      targets = [...new Set(names.map(name => {
        const tool = toolManager.get(name);
        if (!tool) throw new Error(t('auth_unknown_tool', { tool: name }));
        return tool;
      }))];
    } else if (interactive) {
      const names = await promptHelper.checkbox(t('setup_select_tools'), toolManager.getAll().map(tool => ({ name: tool.displayName, value: tool.name })));
      targets = names.map(name => toolManager.get(name)!);
    } else {
      for (const tool of toolManager.getAll()) {
        try {
          const installed = tool.isInstalled();
          if (installed === true) targets.push(tool);
          else skipped.push({ tool, status: 'skipped', reason: installed === null ? 'setup_reason_desktop' : 'setup_reason_not_installed' });
        } catch { skipped.push({ tool, status: 'failed', reason: 'installation_detection_failed' }); }
      }
    }
    let apiKey = configManager.getApiKey();
    if (options.keyStdin) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 65536) throw new Error('API key input is too long');
        chunks.push(bytes);
      }
      apiKey = Buffer.concat(chunks).toString('utf8').trim();
      if (!apiKey || /\s/.test(apiKey)) throw new Error('Expected one API key');
      const validation = await validateApiKey(apiKey, configManager.baseUrl);
      if (!validation.valid) throw new Error(validation.error ?? 'Invalid API key');
    }
    if (!apiKey && (options.keyStdin || targets.some(tool => !configManager.getConnection(tool.name).apiKey))) throw new Error(t('setup_no_key'));
    const models = configManager.getModels();
    // 每个目标先固定实际连接，账户检查与写入共用同一对象。
    const connections = new Map(targets.map(tool => [tool.name, options.keyStdin
      ? { apiKey, baseUrl: configManager.baseUrl, endpoint: configManager.getEndpoint() }
      : configManager.getConnection(tool.name)]));
    const groups = new Map<string, { connection: Connection; tools: ITool[] }>();
    for (const tool of targets) {
      const connection = connections.get(tool.name)!;
      const identity = JSON.stringify([connection.baseUrl, connection.apiKey]);
      const group = groups.get(identity) ?? { connection, tools: [] };
      group.tools.push(tool); groups.set(identity, group);
    }
    const accounts = new Map<string, AccountStatus>();
    for (const { connection, tools } of groups.values()) {
      const preferred = tools.map(tool => savedModelFor(tool, models)).filter((id): id is string => !!id);
      const result = await checkAccountStatus(connection.apiKey!, connection.baseUrl, preferred);
      for (const tool of tools) accounts.set(tool.name, result);
      if (result.usable !== true && !options.json) uiRenderer.renderWarning(describeAccountStatus(result));
    }
    const account = groups.size === 1 ? accounts.get(targets[0]?.name) : undefined;
    const perform = async (): Promise<ToolResult[]> => {
      const results: ToolResult[] = [];
      for (const tool of targets) {
        if (interactive && !options.dryRun && tool.requiresModelSelection && !tool.launchOnly && !hasSavedToolModelConfig(tool, configManager.getModels())) await tool.runModelConfigFlow();
        const apply = () => applyTool(tool, { apiKey: connections.get(tool.name)!.apiKey!, baseUrl: connections.get(tool.name)!.baseUrl });
        results.push(await (options.json || options.dryRun ? withQuietLogs(apply) : apply()));
      }
      return results;
    };
    const planned = options.dryRun ? await previewWrites(perform) : { value: await perform(), changes: [] };
    const results = planned.value;
    if (options.keyStdin && !options.dryRun && results.some(result => result.status === 'success')) {
      configManager.setApiKey(apiKey!);
      for (const result of results) if (result.status === 'success') configManager.setToolProfile(result.tool.name, undefined);
      modelService.clearCache(); marketModelService.clearCache();
    }
    results.push(...skipped);
    const exitCode = exitCodeFor(results);
    const preview = options.dryRun ? { dryRun: true, changes: publicPlannedChanges(planned.changes) } : {};
    if (options.json) console.log(JSON.stringify({ results: jsonToolResults(results), account, accounts: Object.fromEntries(accounts), ...preview, exitCode }, null, 2));
    else {
      renderToolResults(results, apiKey, !!options.dryRun);
      if (options.dryRun) for (const change of publicPlannedChanges(planned.changes)) console.log(JSON.stringify(change));
    }
    process.exitCode = exitCode;
  } catch (error) {
    if (options.json) console.log(JSON.stringify({ error: 'setup_failed', exitCode: 1 }));
    else uiRenderer.renderError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
