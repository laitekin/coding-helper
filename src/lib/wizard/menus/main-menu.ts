import { t, i18n } from '../../i18n.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { uiRenderer, connectedToolNames } from '../ui/ui-renderer.js';
import { menuPrompt } from '../ui/prompts.js';
import { runLanguageFlow } from '../flows/language-flow.js';
import { runEndpointSelectionFlow } from '../flows/endpoint-selection-flow.js';
import { runApiKeyFlow } from '../flows/api-key-flow.js';
import { runContextFlow, contextLabel } from '../flows/context-flow.js';
import { runProfileMenu } from '../flows/profile-flow.js';
import { runModelPickFlow } from '../flows/model-pick-flow.js';
import { showToolSelector } from './tool-menu.js';
import { toolManager } from '../../tool-manager.js';
import { configManager, type ModelConfig } from '../../config.js';
import { savedModelFor } from '../../core/model-mapping.js';
import { logger } from '../../../utils/logger.js';
import { selectTools, setupTools } from '../flows/tool-setup-flow.js';
import { applyToolsWithProgress, renderResultSummary } from '../ui/tool-view.js';
import { doctorCommand } from '../../../commands/doctor.js';
import { restoreCommand } from '../../../commands/setup.js';

// 主菜单操作
type MainMenuAction =
  | 'setup_all'
  | 'tools'
  | 'model'
  | 'context'
  | 'profile'
  | 'endpoint'
  | 'apikey'
  | 'doctor'
  | 'restore'
  | 'language'
  | 'update'
  | 'clear_config'
  | 'exit';

// 主菜单：每项右侧显示当前值，数字 / 字母直接跳到对应功能
export async function showMainMenu(): Promise<void> {
  let last: MainMenuAction | undefined;
  while (true) {
    uiRenderer.renderHeader();

    const connected = connectedToolNames();
    // 只检测是否安装，不查版本（查版本要逐个启动工具，太慢）
    const installed = toolManager.getAll().filter((tool) => !tool.launchOnly && tool.isInstalled() !== false);
    const pending = installed.filter((tool) => !connected.includes(tool.name)).length;
    const total = toolManager.getAll().filter((tool) => !tool.launchOnly).length;
    const models = configManager.getModels();
    const apiKey = configManager.getApiKey();

    const { value: action, action: key } = await menuPrompt<MainMenuAction>({
      message: t('menu_select_action'),
      default: last,
      items: [
        { value: 'setup_all', key: '1', label: t('menu_setup_all'), hint: pending > 0 ? t('menu_hint_pending', { count: String(pending) }) : t('menu_hint_all_connected') },
        { value: 'tools', key: '2', label: t('menu_configure_tools'), hint: t('menu_hint_connected', { count: String(connected.length), total: String(total) }) },
        { value: 'model', key: '3', label: t('menu_switch_model'), hint: currentModelHint(connected, models) },
        { value: 'context', key: '4', label: t('menu_context'), hint: contextLabel() },
        { value: 'profile', key: '5', label: t('menu_profiles'), hint: configManager.getActiveProfile() ?? t('menu_hint_profile_none') },
        { value: 'endpoint', key: '6', label: t('menu_configure_endpoint'), hint: uiRenderer.endpointLabel() },
        { value: 'apikey', key: '7', label: t('menu_configure_apikey'), hint: apiKey ? uiRenderer.maskApiKey(apiKey) : t('config_view_not_set') },
        { value: 'doctor', key: '8', label: t('menu_doctor'), hint: 'doctor' },
        { value: 'restore', key: '9', label: t('menu_restore'), hint: connected.length ? t('menu_hint_restore', { count: String(connected.length) }) : '' },
        { separator: '' },
        { value: 'language', key: 'l', label: t('menu_configure_language'), hint: i18n.getLocale() === 'zh_CN' ? '简体中文' : 'English' },
        { value: 'update', key: 'u', label: t('menu_update_helper') },
        { value: 'clear_config', key: 'c', label: t('menu_clear_config') },
        { value: 'exit', key: 'q', label: t('menu_exit') },
      ],
      footer: [['↑↓', t('ui_key_move')], ['⏎', t('ui_key_confirm')], ['1-9', t('ui_key_jump')], ['q', t('menu_exit')]],
    });
    void key;
    last = action;

    switch (action) {
      case 'setup_all':
        await runSetupAll();
        break;
      case 'tools':
        await showToolSelector();
        break;
      case 'model':
        await switchModel();
        break;
      case 'context':
        await runContextFlow();
        break;
      case 'profile':
        await runProfileMenu();
        break;
      case 'endpoint':
        await runEndpointSelectionFlow();
        break;
      case 'apikey':
        await runApiKeyFlow();
        break;
      case 'doctor':
        uiRenderer.renderHeader();
        await doctorCommand();
        await promptHelper.pressEnter();
        break;
      case 'restore':
        uiRenderer.renderHeader();
        await restoreCommand(undefined, {});
        process.exitCode = 0;
        await promptHelper.pressEnter();
        break;
      case 'language':
        await runLanguageFlow();
        break;
      case 'update':
        await updateHelper();
        break;
      case 'clear_config':
        if (await handleClearConfig()) return;
        break;
      case 'exit':
        return;
    }
  }
}

// 已接入工具的模型：统一时显示模型名，不一致时显示「各不相同」
function currentModelHint(connected: string[], models: ModelConfig): string {
  const used = [...new Set(toolManager.getAll()
    .filter((tool) => connected.includes(tool.name))
    .map((tool) => savedModelFor(tool, models) ?? tool.defaultModel)
    .filter((m): m is string => !!m))];
  if (used.length === 1) return used[0];
  if (used.length > 1) return t('menu_hint_models_mixed', { count: String(used.length) });
  return models.defaultModel ?? t('config_view_not_set');
}

// 一键接入：多选工具（默认勾选已安装），选模型后批量装载
async function runSetupAll(): Promise<void> {
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('menu_setup_all'));
  const tools = await selectTools(t('setup_select_tools'));
  if (tools.length === 0) return;
  await setupTools(tools);
}

// 切换模型：对已接入的工具统一换模型并重新写入
async function switchModel(): Promise<void> {
  const tools = toolManager.getAll().filter((tool) => connectedToolNames().includes(tool.name));
  if (tools.length === 0) {
    uiRenderer.renderHeader();
    uiRenderer.renderHint(t('menu_switch_model_none'));
    await promptHelper.pressEnter();
    return;
  }
  const result = await runModelPickFlow(tools);
  if (result === 'cancelled') return;
  if (result === 'per_tool') {
    for (const tool of tools) await tool.runModelConfigFlow();
  }
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('setup_title'));
  const results = await applyToolsWithProgress(tools);
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('setup_title'));
  renderResultSummary(results);
  await promptHelper.pressEnter();
}

// 更新 Coding Helper
async function updateHelper(): Promise<void> {
  logger.info(t('update_running'));
  const { execSync } = await import('node:child_process');
  try {
    execSync('npm install -g qiniu-coding-helper@latest', { stdio: 'inherit' });
    uiRenderer.renderSuccess(t('update_latest'));
  } catch {
    uiRenderer.renderError(t('error_unknown'));
  }
  await promptHelper.pressEnter();
}

// 清除配置，成功返回 true
async function handleClearConfig(): Promise<boolean> {
  uiRenderer.renderHeader();
  const confirmed = await promptHelper.confirm(t('clear_config_confirm'), false);
  if (!confirmed) return false;

  configManager.clearConfig();
  uiRenderer.renderHeader();
  uiRenderer.renderSuccess(t('clear_config_success'));
  return true;
}
