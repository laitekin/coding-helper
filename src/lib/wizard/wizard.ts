import { t, i18n } from '../i18n.js';
import { configManager } from '../config.js';
import { uiRenderer } from './ui/ui-renderer.js';
import { runLanguageFlow } from './flows/language-flow.js';
import { runEndpointSelectionFlow } from './flows/endpoint-selection-flow.js';
import { runApiKeyFlow } from './flows/api-key-flow.js';
import { showMainMenu } from './menus/main-menu.js';
import { runToolSetupFlow } from './flows/tool-setup-flow.js';

// 首次向导步骤数：语言、线路、API Key、工具、模型
const INIT_STEPS = 5;

// Wizard 协调器 - 管理首次运行向导和主菜单
export class Wizard {
  // 运行首次初始化向导
  async runInitWizard(): Promise<void> {
    // 1. 选择语言（含欢迎卡片，首次使用固定中文提示选择语言）
    await runLanguageFlow({ current: 1, total: INIT_STEPS });

    // 2. 选择线路
    await runEndpointSelectionFlow({ current: 2, total: INIT_STEPS });

    // 3. 输入 API Key（首次配置时还没有已接入的客户端，无需同步）
    await runApiKeyFlow({ current: 3, total: INIT_STEPS });

    // 4-5. 多选工具 → 选模型 → 批量装载 → 结果页
    await runToolSetupFlow({ current: 4, total: INIT_STEPS });

    // 初始化完成
    uiRenderer.renderSuccess(t('init_complete'));
  }

  // 进入主菜单
  async runMainMenu(): Promise<void> {
    await showMainMenu();
  }

  // 智能入口：首次运行走向导，否则进主菜单
  async run(): Promise<void> {
    // 初始化 i18n
    i18n.init();

    if (configManager.isFirstRun()) {
      await this.runInitWizard();
    }

    // 向导完成后或非首次运行，直接进入主菜单（内部已包含 renderHeader）
    await this.runMainMenu();
  }
}
