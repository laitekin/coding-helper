import { t } from '../../i18n.js';
import { promptHelper } from '../ui/prompt-helper.js';
import { uiRenderer } from '../ui/ui-renderer.js';
import { theme } from '../ui/theme.js';
import { runLanguageFlow } from '../flows/language-flow.js';
import { runEndpointSelectionFlow } from '../flows/endpoint-selection-flow.js';
import { runApiKeyFlow } from '../flows/api-key-flow.js';
import { showToolMenu } from './tool-menu.js';
import { toolManager } from '../../tool-manager.js';
import { configManager } from '../../config.js';
import { logger } from '../../../utils/logger.js';
import chalk from 'chalk';
import { selectTools, setupTools } from '../flows/tool-setup-flow.js';
import { formatToolChoice } from '../ui/tool-view.js';
import { detectAllTools } from '../../core/tool-service.js';
import { stringWidth } from '../../../utils/string-width.js';

// 主菜单操作
type MainMenuAction =
  | 'language'
  | 'endpoint'
  | 'apikey'
  | 'setup_all'
  | 'tools'
  | 'clear_config'
  | 'update'
  | 'exit';

// 主菜单
export async function showMainMenu(): Promise<void> {
  while (true) {
    uiRenderer.renderHeader();

    uiRenderer.renderTitle(t('menu_main_title'));

    const action = await promptHelper.select<MainMenuAction>(t('menu_select_action'), [
      { name: `${theme.brandBold('★')} ${theme.brandBold(t('menu_setup_all'))}`, value: 'setup_all' },
      { name: `${theme.icon('◆')} ${t('menu_configure_language')}`, value: 'language' },
      { name: `${theme.icon('◇')} ${t('menu_configure_endpoint')}`, value: 'endpoint' },
      { name: `${theme.icon('◈')} ${t('menu_configure_apikey')}`, value: 'apikey' },
      { name: `${theme.icon('▸')} ${t('menu_configure_tools')}`, value: 'tools' },
      { name: `${theme.dimIcon('▪')} ${t('menu_clear_config')}`, value: 'clear_config' },
      { name: `${theme.dimIcon('△')} ${t('menu_update_helper')}`, value: 'update' },
      { name: `${theme.dimIcon('◁')} ${t('menu_exit')}`, value: 'exit' },
    ]);

    switch (action) {
      case 'language':
        await runLanguageFlow();
        break;
      case 'endpoint':
        await runEndpointSelectionFlow();
        break;
      case 'apikey':
        await runApiKeyFlow();
        break;
      case 'setup_all':
        await runSetupAll();
        break;
      case 'tools':
        await showToolSelector();
        break;
      case 'clear_config':
        if (await handleClearConfig()) return;
        break;
      case 'update':
        await updateHelper();
        break;
      case 'exit':
        return;
    }
  }
}

// 一键配置：多选工具（默认勾选已安装），逐个配置模型后批量装载
async function runSetupAll(): Promise<void> {
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('menu_setup_all'));
  const tools = await selectTools(t('setup_select_tools'));
  if (tools.length === 0) return;
  await setupTools(tools);
}

// 工具选择器：每行展示版本与接入状态
async function showToolSelector(): Promise<void> {
  uiRenderer.renderHeader();
  uiRenderer.renderTitle(t('menu_configure_tools'));

  const detections = detectAllTools();
  const nameWidth = Math.max(...detections.map((d) => stringWidth(d.tool.displayName)));
  const choices = [
    ...detections.map((d) => ({ name: formatToolChoice(d, nameWidth), value: d.tool.name })),
    { name: `${theme.dimIcon('◁')} ${t('tool_back')}`, value: '__back__' },
  ];

  const toolName = await promptHelper.select<string>(t('menu_select_action'), choices);
  const tool = toolManager.get(toolName);
  if (tool) {
    await showToolMenu(tool);
  }
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
}

// 清除配置，成功返回 true
async function handleClearConfig(): Promise<boolean> {
  uiRenderer.renderHeader();  // 清屏，与其他选项保持一致
  const confirmed = await promptHelper.confirm(t('clear_config_confirm'), false);
  if (!confirmed) return false;

  configManager.clearConfig();
  uiRenderer.renderHeader();  // 清屏并显示更新后的配置状态
  uiRenderer.renderSuccess(t('clear_config_success'));
  return true;
}
