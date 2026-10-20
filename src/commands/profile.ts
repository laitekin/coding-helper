import { t, i18n } from '../lib/i18n.js';
import { configManager } from '../lib/config.js';
import { CUSTOM_ENDPOINT, DEFAULT_ENDPOINT } from '../lib/endpoints.js';
import { validateApiKey } from '../lib/api-validator.js';
import { isValidProfileName } from '../lib/core/quick-args.js';
import { applyTool, getSyncTargets, exitCodeFor, type ToolResult } from '../lib/core/tool-service.js';
import { toolManager } from '../lib/tool-manager.js';
import { uiRenderer } from '../lib/wizard/ui/ui-renderer.js';
import { theme } from '../lib/wizard/ui/theme.js';
import { applyToolsWithProgress, renderResultSummary, syncAfterChange } from '../lib/wizard/ui/tool-view.js';
import { toolsUsingProfile } from '../lib/wizard/flows/profile-flow.js';
import { normalizeCustomBaseUrl } from '../lib/wizard/flows/endpoint-selection-flow.js';
import { modelService } from '../lib/model-service.js';
import { marketModelService } from '../lib/market-model-service.js';
import { logger } from '../utils/logger.js';
import type { ITool } from '../lib/tools/base-tool.js';

function fail(message: string): void {
  uiRenderer.renderError(message);
  process.exitCode = 1;
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

// profile list
export function profileListCommand(options: { json?: boolean }): void {
  i18n.init();
  const active = configManager.getActiveProfile();
  const profiles = configManager.listProfiles();
  if (options.json) {
    console.log(JSON.stringify({
      active: active ?? null,
      profiles: profiles.map((p) => ({
        name: p.name,
        endpoint: p.endpoint,
        baseUrl: p.baseUrl,
        apiKey: uiRenderer.maskApiKey(p.apiKey),
        tools: toolsUsingProfile(p.name, true),
      })),
    }, null, 2));
    return;
  }
  if (profiles.length === 0) {
    uiRenderer.renderHint(t('profile_empty_hint'));
    logger.log(`  ${theme.subtle('coding-helper profile add work sk-xxx')}`);
    return;
  }
  uiRenderer.renderTable(
    [t('profile_col_name'), 'API Key', t('config_view_endpoint'), t('profile_col_tools')],
    profiles.map((p) => [
      p.name === active ? theme.brandBold(`● ${p.name}`) : `  ${p.name}`,
      uiRenderer.maskApiKey(p.apiKey),
      uiRenderer.endpointLabel(p.endpoint, p.baseUrl),
      theme.subtle(toolsUsingProfile(p.name).join(', ') || '—'),
    ]),
  );
}

// profile add <name> [key] [--intl | --base-url <url>] [--key-stdin]
export async function profileAddCommand(
  name: string,
  key: string | undefined,
  options: { intl?: boolean; baseUrl?: string; keyStdin?: boolean; use?: boolean },
): Promise<void> {
  i18n.init();
  if (!isValidProfileName(name)) return fail(t('profile_name_invalid'));
  const apiKey = (options.keyStdin ? await readStdin() : key ?? process.env.QINIU_API_KEY ?? '').trim();
  if (!apiKey) return fail(t('profile_add_key_missing'));

  let endpoint = options.intl ? 'international' : DEFAULT_ENDPOINT;
  let customUrl: string | undefined;
  if (options.baseUrl) {
    customUrl = normalizeCustomBaseUrl(options.baseUrl);
    if (!customUrl) return fail(t('endpoint_custom_invalid', { value: options.baseUrl }));
    endpoint = CUSTOM_ENDPOINT;
  }

  configManager.saveProfile(name, apiKey, endpoint, customUrl);
  const profile = configManager.getProfile(name)!;
  const result = await validateApiKey(apiKey, profile.baseUrl);
  if (result.valid) uiRenderer.renderSuccess(t('profile_test_ok', { name, endpoint: uiRenderer.endpointLabel(profile.endpoint, profile.baseUrl) }));
  else uiRenderer.renderWarning(t('profile_saved_unverified', { name }) + (result.error ? ` (${result.error})` : ''));

  if (options.use || !configManager.getActiveProfile()) await profileUseCommand(name, undefined, { sync: false });
  else logger.log(theme.subtle(`  ${t('profile_use_hint', { name })}`));
}

// profile use <name> [tools]：不带工具时切换当前配置档并同步全部已接入工具；带工具时只把这些工具绑定到它
export async function profileUseCommand(name: string, tools: string | undefined, options: { sync?: boolean } = {}): Promise<void> {
  i18n.init();
  if (!configManager.getProfile(name)) return fail(t('quick_profile_not_found', { name }));

  if (!tools) {
    configManager.useProfile(name);
    modelService.clearCache();
    marketModelService.clearCache();
    uiRenderer.renderSuccess(t('profile_switched', { name }));
    // 只改用户确认的工具：--sync 更新全部；交互终端里勾选；否则只切换配置档
    let results: ToolResult[] = [];
    if (options.sync) {
      results = await applyToolsWithProgress(getSyncTargets());
      if (results.length) renderResultSummary(results);
    } else if (process.stdin.isTTY) {
      results = await syncAfterChange();
    } else if (getSyncTargets().length) {
      uiRenderer.renderHint(t('sync_cli_hint'));
    }
    process.exitCode = results.length ? exitCodeFor(results) : 0;
    return;
  }

  const targets: ITool[] = [];
  for (const toolName of tools.split(',').map((x) => x.trim()).filter(Boolean)) {
    const tool = toolManager.get(toolName);
    if (!tool) return fail(t('quick_unknown_tool', { tool: toolName, tools: toolManager.getAll().map((x) => x.name).join(', ') }));
    targets.push(tool);
  }
  const results: ToolResult[] = [];
  for (const tool of targets) {
    configManager.setToolProfile(tool.name, name);
    results.push(await applyTool(tool));
  }
  for (const r of results) {
    if (r.status === 'success') uiRenderer.renderSuccess(t('profile_tool_bound', { tool: r.tool.displayName, name }));
    else uiRenderer.renderError(`${r.tool.displayName}: ${r.reason ? t(r.reason) : ''}`);
  }
  process.exitCode = exitCodeFor(results);
}

// profile remove <name>
export async function profileRemoveCommand(name: string): Promise<void> {
  i18n.init();
  if (!configManager.getProfile(name)) return fail(t('quick_profile_not_found', { name }));
  const pinned = toolManager.getAll().filter((tool) => configManager.getToolProfile(tool.name) === name);
  configManager.removeProfile(name);
  uiRenderer.renderSuccess(t('profile_deleted', { name }));
  // 绑定在它上面的工具不自动改写，提示用户自己决定
  if (pinned.length) {
    uiRenderer.renderHint(t('profile_removed_pinned_hint', {
      tools: pinned.map((tool) => tool.displayName).join(', '),
      command: `coding-helper auth reload ${pinned[0].name}`,
    }));
  }
}
