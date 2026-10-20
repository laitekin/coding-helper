import { type ModelConfig } from '../config.js';

// 工具接口定义
export interface ITool {
  name: string;
  displayName: string;
  command: string;
  installCommand: string;

  // 命令行别名（如 codebuddy 工具支持 'workbuddy' 别名）
  aliases?: string[];

  // 更新命令（可选，默认使用 installCommand）
  updateCommand?: string;

  // npm 包名（用于查询最新版本）
  npmPackageName?: string;

  // 检查工具是否已安装
  // 返回 null 表示无法检测（如桌面应用）
  isInstalled(): boolean | null;

  // 获取当前安装的工具版本，未安装返回 null
  getVersion(): string | null;

  // 获取当前工具配置
  getConfig(): Record<string, unknown>;

  // 客户端的配置文件当前是否指向七牛（读实际文件，用于 status / 状态徽标）
  isConfigured(): boolean;

  // 装载前必须先选择模型（无默认模型可用）
  requiresModelSelection?: boolean;

  // 未指定模型且通用模型不兼容时，该工具自己的默认模型（如 Codex 的 GPT 模型）
  defaultModel?: string;

  // 检查模型能否用于该工具；返回不兼容的原因（i18n key），undefined 表示可用
  checkModel?(model: string, ctx: { apiKey: string; baseUrl: string }): Promise<string | undefined>;

  // 没有配置文件、只能通过 run 启动器使用的客户端（如 Copilot CLI）
  launchOnly?: boolean;

  // 启动器模式：只注入子进程的环境变量，不改用户配置文件
  getLaunchEnv?(apiKey: string, baseUrl: string, models: ModelConfig): Record<string, string>;

  // 清除模型配置
  clearModelConfig(): void;

  // 将完整配置写入工具
  loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void>;

  // 从工具移除配置
  unloadConfig(): void | Promise<void>;

  // 运行该工具特定的模型配置流程（角色选择、多选模型等由各工具自定义）
  // 返回 true 表示用户完成并保存了配置；false 表示用户取消、未选或前置条件不满足
  runModelConfigFlow(): Promise<boolean>;

  // 渲染该工具的模型配置摘要（用于"查看当前配置"菜单）
  renderModelConfigSummary(): void;
}
