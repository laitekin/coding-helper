import chalk from 'chalk';
import { t } from '../../i18n.js';
import { configManager } from '../../config.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { uiRenderer } from '../ui/ui-renderer.js';
import { theme } from '../ui/theme.js';
import type { ITool } from '../../tools/base-tool.js';
import { logger } from '../../../utils/logger.js';
import { fetchLatestVersion, isNewerVersion } from '../../version-service.js';
import { applyToolsWithProgress, formatConfiguredBadge, formatInstallState, renderResultSummary, toolIcon } from '../ui/tool-view.js';
import { detectAllTools, detectTool, hasSavedToolModelConfig, removeTool, applyTool, type ToolDetection } from '../../core/tool-service.js';
import { menuPrompt, type MenuEntry } from '../ui/prompts.js';
import { renderSprite, joinBlocks, pixelsSupported, SPRITE_WIDTH } from '../ui/pixel.js';
import { savedModelFor } from '../../core/model-mapping.js';
import { toolManager } from '../../tool-manager.js';
import { setupTools } from '../flows/tool-setup-flow.js';
import { theme as uiTheme } from '../ui/theme.js';
import { padVisible } from '../../../utils/string-width.js';

// 工具菜单操作
type ToolMenuAction =
  | 'models'
  | 'load'
  | 'profile'
  | 'unload'
  | 'launch'
  | 'update'
  | 'view'
  | 'back';

const BACK = '__back__';

// 工具的当前模型（未接入时为空）
function currentModel(detection: ToolDetection): string | undefined {
  if (!detection.configured) return undefined;
  return savedModelFor(detection.tool, configManager.getModels()) ?? detection.tool.defaultModel;
}

// 工具列表一行：色块 · 名称 · 版本 · 接入状态，右侧当前模型
function toolEntry(detection: ToolDetection, nameWidth: number): MenuEntry<string> {
  const { tool } = detection;
  const installed = detection.installed !== false;
  const model = currentModel(detection);
  const profile = configManager.getToolProfile(tool.name);
  const config = tool.getConfig();
  const configPath = typeof config.configPath === 'string' ? config.configPath : typeof config.settingsPath === 'string' ? config.settingsPath : undefined;
  const description = installed
    ? [
        model ? `${uiTheme.subtle(t('tool_detail_model'))}  ${chalk.hex('#8BE9FF')(model)}` : uiTheme.subtle(t('tool_detail_not_connected')),
        `${uiTheme.subtle(t('tool_detail_connection'))}  ${uiTheme.value(profile ? `${t('profile_label')} ${profile}` : uiRenderer.endpointLabel())}`,
        configPath ? `${uiTheme.subtle(t('tool_detail_config'))}  ${uiTheme.subtle(configPath.replace(process.env.HOME ?? '~', '~'))}` : '',
      ].filter(Boolean).join('\n')
    : `${uiTheme.subtle(t('tool_detail_install'))}  ${uiTheme.value(tool.installCommand)}`;
  return {
    value: tool.name,
    icon: toolIcon(tool.name, !installed),
    label: `${padVisible(tool.displayName, nameWidth)}  ${padVisible(formatInstallState(detection), 10)}  ${formatConfiguredBadge(detection)}`,
    hint: model ? chalk.hex('#7D8B99')(model.split('/').pop() ?? model) : '',
    description,
    search: tool.name,
  };
}

// 工具列表：已安装 / 未安装分组；⏎ 打开 · m 换模型 · s 启动 · r 还原 · a 全部接入 · / 搜索
export async function showToolSelector(): Promise<void> {
  let last: string | undefined;
  while (true) {
    uiRenderer.renderHeader();
    uiRenderer.renderTitle(t('menu_configure_tools'));
    const detections = detectAllTools();
    const nameWidth = Math.max(...detections.map((d) => d.tool.displayName.length));
    const installed = detections.filter((d) => d.installed !== false);
    const missing = detections.filter((d) => d.installed === false);
    const { value, action } = await menuPrompt<string>({
      message: t('menu_select_action'),
      default: last,
      escape: true,
      searchable: true,
      actions: ['m', 's', 'r', 'a'],
      pageSize: 18,
      items: [
        { separator: uiTheme.subtle(t('tool_group_installed', { count: String(installed.length) })) },
        ...installed.map((d) => toolEntry(d, nameWidth)),
        ...(missing.length ? [{ separator: uiTheme.subtle(t('tool_group_missing', { count: String(missing.length) })) }] : []),
        ...missing.map((d) => toolEntry(d, nameWidth)),
        { separator: '' },
        { value: BACK, key: 'q', label: t('tool_back') },
      ],
      footer: [['↑↓', t('ui_key_move')], ['⏎', t('ui_key_open')], ['m', t('tool_key_model')], ['s', t('tool_key_launch')], ['r', t('tool_key_restore')], ['a', t('tool_key_all')], ['/', t('ui_key_search')], ['esc', t('ui_key_back')]],
    });
    if (action === 'escape' || value === BACK) return;
    last = value;
    if (action === 'a') {
      const connected = new Set(detections.filter((d) => d.configured).map((d) => d.tool.name));
      const todo = installed.filter((d) => !connected.has(d.tool.name) && !d.tool.launchOnly).map((d) => d.tool);
      if (todo.length) await setupTools(todo);
      continue;
    }
    const tool = toolManager.get(value);
    if (!tool) continue;
    if (action === 'm') {
      if (await tool.runModelConfigFlow()) await applyConfig(tool);
    } else if (action === 's') await launchTool(tool);
    else if (action === 'r') await unloadWithConfirm(tool);
    else await showToolMenu(tool);
  }
}

// 工具详情头部：大号像素角色 + 名称、状态、版本、模型、连接
function renderToolCard(tool: ITool, latestLine: string): void {
  const detection = detectTool(tool);
  const model = currentModel(detection);
  const profile = configManager.getToolProfile(tool.name);
  const info = [
    chalk.bold.hex('#E8F6FF')(tool.displayName),
    formatConfiguredBadge(detection),
    `${uiTheme.subtle(t('tool_version_installed'))} ${formatInstallState(detection)}  ${latestLine}`,
    `${uiTheme.subtle(t('tool_detail_model'))} ${model ? chalk.hex('#8BE9FF')(model) : uiTheme.subtle('—')}`,
    `${uiTheme.subtle(t('tool_detail_connection'))} ${uiTheme.value(profile ? `${t('profile_label')} ${profile}` : uiRenderer.endpointLabel())}`,
  ];
  if (pixelsSupported()) {
    for (const line of joinBlocks([renderSprite(tool.name, !detection.configured), info], [SPRITE_WIDTH, 0], 3)) logger.log(`  ${line}`);
  } else {
    for (const line of info) logger.log(`  ${line}`);
  }
  logger.newLine();
}

function latestVersionLine(installed: string | null, latest: string | null, fetchCompleted: boolean, npmPackageName?: string): string {
  if (!npmPackageName || !installed) return '';
  if (!latest) return uiTheme.subtle(t(getMissingLatestVersionDisplayKey(fetchCompleted)));
  return isNewerVersion(installed, latest)
    ? chalk.yellow(`${t('tool_version_latest')} ${latest} · ${t('tool_version_update_hint')}`)
    : chalk.green(t('tool_version_up_to_date'));
}

async function unloadWithConfirm(tool: ITool): Promise<void> {
  uiRenderer.renderHeader();
  const confirmed = await promptHelper.confirm(t('tool_config_unload_confirm', { tool: tool.displayName }), false);
  if (!confirmed) return;
  const result = await removeTool(tool);
  uiRenderer.renderHeader();
  if (result.status === 'success') {
    uiRenderer.renderSuccess(t('tool_config_unloaded', { tool: tool.displayName }));
    uiRenderer.renderHint(t('tool_config_restored_hint'));
  } else {
    uiRenderer.renderError(t('tool_config_unload_failed', { tool: tool.displayName }));
    if (result.reason) uiRenderer.renderHint(result.reason);
  }
  await promptHelper.pressEnter();
}

// 把单个工具绑定到某个配置档（或跟随当前配置档）后重新写入
async function chooseToolProfile(tool: ITool): Promise<void> {
  const profiles = configManager.listProfiles();
  const active = configManager.getActiveProfile();
  const current = configManager.getToolProfile(tool.name) ?? '';
  uiRenderer.renderHeader();
  const { value, action } = await menuPrompt<string>({
    message: t('tool_profile_prompt', { tool: tool.displayName }),
    default: current,
    escape: true,
    items: [
      { value: '', label: t('tool_profile_follow', { name: active ?? t('menu_hint_profile_none') }) },
      ...profiles.filter((p) => p.name !== active).map((p) => ({ value: p.name, label: p.name, hint: `${uiRenderer.maskApiKey(p.apiKey)} · ${uiRenderer.endpointLabel(p.endpoint, p.baseUrl)}` })),
    ],
    footer: [['⏎', t('ui_key_confirm')], ['esc', t('ui_key_back')]],
  });
  if (action === 'escape') return;
  configManager.setToolProfile(tool.name, value || undefined);
  await applyConfig(tool);
}

// 工具配置菜单
export async function showToolMenu(tool: ITool): Promise<void> {
  if (!hasSavedToolModelConfig(tool, configManager.getModels())) {
    await runInitialToolSetup(tool);
  }

  // 异步获取最新版本（不阻塞菜单渲染）
  let latestVersion: string | null = null;
  let fetchCompleted = false;
  let fetchPromise: Promise<string | null> | null = null;

  if (tool.npmPackageName) {
    fetchPromise = fetchLatestVersion(tool.npmPackageName);
    fetchPromise
      .then(v => {
        latestVersion = v;
      })
      .catch(() => {})
      .finally(() => {
        fetchCompleted = true;
      });
  }

  while (true) {
    uiRenderer.renderHeader();
    const installedVersion = tool.getVersion();
    renderToolCard(tool, latestVersionLine(installedVersion, latestVersion, fetchCompleted, tool.npmPackageName));

    // 如果最新版本还未获取到，设置 AbortController 以便版本到达后自动刷新
    const controller = new AbortController();
    if (fetchPromise && isLatestVersionFetchPending({ fetchPromise, fetchCompleted })) {
      fetchPromise.then(() => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      });
    }

    const hasProfiles = configManager.listProfiles().length > 1;
    let action: ToolMenuAction;
    try {
      const result = await menuPrompt<ToolMenuAction>({
        message: t('menu_select_action'),
        escape: true,
        items: [
          { value: 'load', key: '1', label: t('tool_load_config'), hint: detectTool(tool).configured ? t('tool_hint_rewrite') : '' },
          { value: 'models', key: 'm', label: t('tool_configure_models') },
          ...(hasProfiles ? [{ value: 'profile' as const, key: 'p', label: t('tool_use_profile'), hint: configManager.getToolProfile(tool.name) ?? t('tool_profile_following') }] : []),
          { value: 'launch', key: 's', label: t('tool_launch'), hint: tool.command },
          { value: 'unload', key: 'r', label: t('tool_unload_config') },
          { value: 'update', key: 'u', label: t('tool_update') },
          { value: 'view', key: 'v', label: t('tool_view_config') },
          { separator: '' },
          { value: 'back', key: 'q', label: t('tool_back') },
        ],
        footer: [['↑↓', t('ui_key_move')], ['⏎', t('ui_key_confirm')], ['esc', t('ui_key_back')]],
      }, { signal: controller.signal });
      action = result.action === 'escape' ? 'back' : result.value;
    } catch (e: unknown) {
      // 版本查询完成触发的 abort，重新渲染菜单
      if (e instanceof Error && e.name === 'AbortPromptError') {
        continue;
      }
      throw e;
    }

    switch (action) {
      case 'models':
        await tool.runModelConfigFlow();
        break;

      case 'load':
        await loadConfig(tool);
        break;

      case 'unload':
        await unloadWithConfirm(tool);
        break;

      case 'profile':
        await chooseToolProfile(tool);
        break;

      case 'launch':
        await launchTool(tool);
        break;

      case 'update':
        await updateTool(tool);
        // 更新后重新获取最新版本信息
        if (tool.npmPackageName) {
          fetchPromise = fetchLatestVersion(tool.npmPackageName);
          fetchCompleted = false;
          latestVersion = await fetchPromise;
          fetchCompleted = true;
        }
        break;

      case 'view':
        await viewConfig(tool);
        break;

      case 'back':
        return;
    }
  }
}

export function isLatestVersionFetchPending(state: {
  fetchPromise: Promise<string | null> | null;
  fetchCompleted: boolean;
}): state is { fetchPromise: Promise<string | null>; fetchCompleted: false } {
  return Boolean(state.fetchPromise && !state.fetchCompleted);
}

// 兼容旧导入路径
export { hasSavedToolModelConfig };

async function runInitialToolSetup(tool: ITool): Promise<void> {
  const completed = await tool.runModelConfigFlow();
  if (!completed) return;
  await applyConfig(tool);
}

// 渲染版本信息区域
function renderVersionInfo(
  installed: string | null,
  latest: string | null,
  fetchCompleted: boolean,
  npmPackageName?: string,
  isDesktop = false,
): void {
  // 桌面应用不显示版本信息
  if (isDesktop) {
    return;
  }

  // 当前版本
  const installedDisplay = installed
    ? chalk.white(installed)
    : chalk.yellow(t('tool_version_not_installed'));
  uiRenderer.renderConfigItem(t('tool_version_installed'), installedDisplay);

  if (!npmPackageName) {
    logger.newLine();
    return;
  }

  // 最新版本
  if (latest) {
    const hasUpdate = installed ? isNewerVersion(installed, latest) : false;
    if (hasUpdate) {
      uiRenderer.renderConfigItem(
        t('tool_version_latest'),
        `${chalk.green(latest)}  ${chalk.yellow(t('tool_version_update_hint'))}`,
      );
    } else {
      uiRenderer.renderConfigItem(
        t('tool_version_latest'),
        `${chalk.white(latest)}  ${chalk.green(t('tool_version_up_to_date'))}`,
      );
    }
  } else {
    uiRenderer.renderConfigItem(
      t('tool_version_latest'),
      chalk.dim(t(getMissingLatestVersionDisplayKey(fetchCompleted))),
    );
  }

  logger.newLine();
}

export function getMissingLatestVersionDisplayKey(fetchCompleted: boolean): string {
  return fetchCompleted ? 'tool_version_unknown' : 'tool_version_checking';
}

// 装载配置到工具
async function loadConfig(tool: ITool): Promise<void> {
  const apiKey = configManager.getApiKey();
  if (!apiKey) {
    uiRenderer.renderError(t('apikey_not_set'));
    await promptHelper.pressEnter();
    return;
  }

  // 清屏后二次确认
  uiRenderer.renderHeader();
  const confirmed = await promptHelper.confirm(
    t('tool_config_load_confirm', { tool: tool.displayName }),
  );
  if (!confirmed) return;

  await applyConfig(tool);
}

async function applyConfig(tool: ITool): Promise<void> {
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('setup_title'));
  const results = await applyToolsWithProgress([tool]);
  renderResultSummary(results);
  await promptHelper.pressEnter();
}

// 启动工具
async function launchTool(tool: ITool): Promise<void> {
  const installed = tool.isInstalled();
  // null 表示无法检测（桌面应用），视为已安装
  if (installed === false) {
    uiRenderer.renderError(t('tool_not_installed', {
      tool: tool.displayName,
      command: tool.installCommand,
    }));
    return;
  }

  // 桌面应用特殊处理：提示手动启动
  if (tool.isInstalled() === null) {
    uiRenderer.renderHint(t('tool_desktop_launch_hint', {
      tool: tool.displayName,
    }));
    await promptHelper.pressEnter();
    return;
  }

  logger.info(t('tool_launching', { tool: tool.displayName }));
  const { execSync } = await import('node:child_process');
  try {
    execSync(tool.command, { stdio: 'inherit' });
  } catch {
    // 用户退出工具时正常
  }
}

// 更新工具
async function updateTool(tool: ITool): Promise<void> {
  // 桌面应用特殊处理：提示手动更新
  if (tool.isInstalled() === null) {
    uiRenderer.renderHint(t('tool_desktop_update_hint', {
      tool: tool.displayName,
    }));
    await promptHelper.pressEnter();
    return;
  }

  const currentVersion = tool.getVersion();

  // 获取最新版本（仅 npm 包支持）
  let latest: string | null = null;
  if (tool.npmPackageName) {
    logger.info(t('update_checking'));
    latest = await fetchLatestVersion(tool.npmPackageName);
  }

  // 已是最新版本，跳过更新
  if (currentVersion && latest && !isNewerVersion(currentVersion, latest)) {
    uiRenderer.renderSuccess(t('tool_update_skipped'));
    return;
  }

  // 有版本信息时，提示确认
  if (currentVersion && latest) {
    const confirmed = await promptHelper.confirm(
      t('tool_update_confirm', { tool: tool.displayName, current: currentVersion, latest }),
    );
    if (!confirmed) return;
  }

  logger.info(t('tool_updating', { tool: tool.displayName }));
  const { execSync } = await import('node:child_process');
  try {
    execSync(tool.updateCommand ?? tool.installCommand, { stdio: 'inherit' });

    // 更新后重新获取版本
    const newVersion = tool.getVersion();
    if (newVersion) {
      uiRenderer.renderSuccess(t('tool_update_success', { tool: tool.displayName, version: newVersion }));
    } else {
      uiRenderer.renderSuccess(t('update_latest'));
    }
  } catch {
    uiRenderer.renderError(t('error_unknown'));
  }
}

// 查看当前配置
async function viewConfig(tool: ITool): Promise<void> {
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('config_view_title'));

  const apiKey = configManager.getApiKey();
  const notSet = t('config_view_not_set');
  uiRenderer.renderConfigItem(t('config_view_endpoint'), configManager.baseUrl);
  uiRenderer.renderConfigItem(
    t('config_view_apikey'),
    apiKey ? uiRenderer.maskApiKey(apiKey) : chalk.dim(notSet),
  );

  tool.renderModelConfigSummary();

  logger.newLine();

  // 显示工具安装状态和版本
  const installed = tool.isInstalled();
  const version = tool.getVersion();

  let statusDisplay: string;
  if (installed === null) {
    // 无法检测（桌面应用），不显示安装状态
    statusDisplay = chalk.dim(t('tool_status_unknown'));
  } else if (installed === false) {
    statusDisplay = chalk.red(t('doctor_not_found'));
  } else if (!version || !tool.npmPackageName) {
    // 桌面应用（无 npmPackageName）只显示"已找到"，不显示版本
    statusDisplay = chalk.green(t('doctor_found'));
  } else {
    // CLI 工具显示版本号
    statusDisplay = `${chalk.green(t('doctor_found'))} (v${version})`;
  }

  uiRenderer.renderConfigItem(tool.displayName, statusDisplay);

  logger.newLine();

  // 等待用户按回车后再返回菜单
  await promptHelper.pressEnter();
}
