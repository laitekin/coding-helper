import { t, i18n } from '../i18n.js';
import { configManager } from '../config.js';
import { uiRenderer } from './ui/ui-renderer.js';
import { runLanguageFlow } from './flows/language-flow.js';
import { runEndpointSelectionFlow } from './flows/endpoint-selection-flow.js';
import { runApiKeyFlow } from './flows/api-key-flow.js';
import { showMainMenu } from './menus/main-menu.js';
import { runSetupFlow } from './flows/tool-setup-flow.js';
import { WIZARD_STEP_KEYS, type StepInfo } from './ui/ui-renderer.js';

// 首次向导：语言、线路、API Key、工具、模型、确认
const INIT_STEPS = WIZARD_STEP_KEYS.length;
const step = (current: number): StepInfo => ({ current, total: INIT_STEPS, keys: WIZARD_STEP_KEYS });

// Wizard 协调器 - 管理首次运行向导和主菜单
export class Wizard {
  // 运行首次初始化向导
  // 每一步 Esc 回到上一步，已填的内容保留（语言、线路已保存，Key 回车沿用）
  async runInitWizard(): Promise<void> {
    const stages: (() => Promise<boolean>)[] = [
      // 1. 语言（含欢迎卡片）
      () => runLanguageFlow(step(1)),
      // 2. 线路
      () => runEndpointSelectionFlow(step(2)),
      // 3. API Key（首次配置时还没有已接入的客户端，无需同步）
      () => runApiKeyFlow(step(3)),
      // 4-6. 勾选工具 → 选模型 → 确认写入 → 结果页
      async () => (await runSetupFlow({ first: 4, total: INIT_STEPS, keys: WIZARD_STEP_KEYS })) === 'done',
    ];
    let index = 0;
    while (index < stages.length) {
      index = (await stages[index]()) ? index + 1 : Math.max(0, index - 1);
    }
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
