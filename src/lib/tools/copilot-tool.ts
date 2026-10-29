import type { ModelConfig } from '../config.js';
import { t } from '../i18n.js';
import { OpenAICompatTool, openAIBaseUrl } from './openai-compat-tool.js';

// GitHub Copilot CLI 只支持环境变量配置，没有配置文件：只走 run 启动器
export class CopilotTool extends OpenAICompatTool {
  name = 'copilot';
  displayName = 'GitHub Copilot CLI';
  command = 'copilot';
  installCommand = 'npm install -g @github/copilot';
  updateCommand = 'npm install -g @github/copilot@latest';
  npmPackageName = '@github/copilot';
  launchOnly = true;

  getConfig(): Record<string, unknown> {
    return {};
  }

  isConfigured(): boolean {
    return false;
  }

  async loadConfig(): Promise<void> {
    throw new Error(t('setup_reason_launch_only'));
  }

  unloadConfig(): void {
    // 没有写入任何文件，无需还原
  }

  getLaunchEnv(apiKey: string, baseUrl: string, models: ModelConfig): Record<string, string> {
    return {
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_BASE_URL: openAIBaseUrl(baseUrl),
      COPILOT_PROVIDER_API_KEY: apiKey,
      COPILOT_MODEL: this.resolveModel(models),
    };
  }
}
