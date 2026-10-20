import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { CUSTOM_ENDPOINT, DEFAULT_ENDPOINT, getBaseUrl, normalizeEndpointId, registerCustomBaseUrls } from './endpoints.js';

// 配置文件路径
const CONFIG_DIR = path.join(os.homedir(), '.coding-helper');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');

// 模型配置接口
export interface ModelConfig {
  claudeCode?: ClaudeCodeConfig;
  codeBuddyModels?: string[];
  workbuddyModels?: string[];
  hermesModel?: string;
  codexModel?: string;
  // 通用客户端（OpenCode、Qwen Code 等）按工具名记录所选模型
  toolModels?: Record<string, string>;
  // 通用客户端未单独选择时使用的默认模型
  defaultModel?: string;
}

export interface ClaudeCodeConfig {
  haikuModel?: string;
  sonnetModel?: string;
  opusModel?: string;
  subagentModel?: string;
  useDefaultModels?: boolean;
}

// 配置档：一组 Key + 线路（国内 / 海外 / 自定义 baseUrl）
export interface ProfileEntry {
  api_key: string;
  endpoint: string;
  base_url?: string;
}

export interface Profile {
  name: string;
  apiKey: string;
  endpoint: string;
  baseUrl: string;
}

// 一个工具实际使用的连接
export interface Connection {
  apiKey?: string;
  endpoint: string;
  baseUrl: string;
  profile?: string;
}

// 配置文件结构
interface Config {
  lang?: string;
  endpoint?: string;
  // endpoint 为 custom 时的地址
  base_url?: string;
  api_key?: string;
  // 当前配置档；顶层 api_key / endpoint 始终是它的副本
  profile?: string;
  profiles?: Record<string, ProfileEntry>;
  // 单独绑定到其他配置档的工具：工具名 → 配置档名
  tool_profiles?: Record<string, string>;
  // 上下文大小上限（token）：按工具设置；context_window 为旧版的全局值，作为兜底
  context_windows?: Record<string, number>;
  context_window?: number;
  claudeCode?: ClaudeCodeConfig;
  codeBuddyModels?: string[];
  workbuddyModels?: string[];
  hermesModel?: string;
  codexModel?: string;
  toolModels?: Record<string, string>;
  defaultModel?: string;
}

// 配置管理器单例
class ConfigManager {
  private config: Config = {};
  private loaded = false;
  // 会话模式：修改只保留在内存中，不写 config.yaml（单条命令的 --no-save / --dry-run）
  private sessionOnly = false;

  // 确保配置目录存在
  private ensureDir(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
  }

  // 加载配置
  private load(): void {
    if (this.loaded) return;
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
        this.config = (yaml.load(content) as Config) || {};
      }
    } catch {
      this.config = {};
    }
    this.loaded = true;
    this.registerCustomUrls();
  }

  // 进入会话模式：之后的修改只在本次进程内生效
  useSessionOnly(): void {
    this.load();
    this.sessionOnly = true;
  }

  // 自定义 baseUrl 也算七牛线路（用于识别、同步与还原）
  private registerCustomUrls(): void {
    registerCustomBaseUrls([
      this.config.base_url,
      ...Object.values(this.config.profiles ?? {}).map((p) => p.base_url),
    ].filter((u): u is string => !!u));
  }

  // 保存配置
  private save(): void {
    this.registerCustomUrls();
    if (this.sessionOnly) return;
    this.ensureDir();
    const content = yaml.dump(this.config, { lineWidth: -1 });
    fs.writeFileSync(CONFIG_FILE, content, { encoding: 'utf-8', mode: 0o600 });
  }

  // 强制重新加载
  reload(): void {
    this.loaded = false;
    this.load();
  }

  // 首次运行检查
  isFirstRun(): boolean {
    return !fs.existsSync(CONFIG_FILE);
  }

  // 语言偏好
  getLang(): string {
    this.load();
    return this.config.lang || 'zh_CN';
  }

  setLang(lang: string): void {
    this.load();
    this.config.lang = lang;
    this.save();
  }

  // 线路选择
  getEndpoint(): string {
    this.load();
    // 规范化旧 id，兼容历史配置（如 modelink → international）
    return normalizeEndpointId(this.config.endpoint || DEFAULT_ENDPOINT);
  }

  setEndpoint(endpoint: string, baseUrl?: string): void {
    this.load();
    this.config.endpoint = endpoint;
    if (endpoint === CUSTOM_ENDPOINT) this.config.base_url = baseUrl;
    else delete this.config.base_url;
    this.syncActiveProfile();
    this.save();
  }

  // API Key 管理
  getApiKey(): string | undefined {
    this.load();
    return this.config.api_key;
  }

  setApiKey(apiKey: string): void {
    this.load();
    this.config.api_key = apiKey;
    this.syncActiveProfile();
    this.save();
  }

  // 仅本次运行生效、不落盘（setup --dry-run 使用）
  useApiKeyForSession(apiKey: string): void {
    this.load();
    this.config.api_key = apiKey;
  }

  revokeApiKey(): void {
    this.load();
    delete this.config.api_key;
    this.save();
  }

  // 清除 coding-helper 配置（语言、线路、Key、模型）
  // 保留 backups/ 与 state.json：之后仍可用 restore 把客户端还原到安装前
  clearConfig(): void {
    this.config = {};
    this.loaded = false;
    fs.rmSync(CONFIG_FILE, { force: true });
  }

  // 模型配置
  getModels(): ModelConfig {
    this.load();
    return {
      claudeCode: this.config.claudeCode ? { ...this.config.claudeCode } : undefined,
      codeBuddyModels: this.config.codeBuddyModels,
      workbuddyModels: this.config.workbuddyModels,
      hermesModel: this.config.hermesModel,
      codexModel: this.config.codexModel,
      toolModels: this.config.toolModels ? { ...this.config.toolModels } : undefined,
      defaultModel: this.config.defaultModel,
    };
  }

  setModels(models: ModelConfig): void {
    this.load();
    // 使用 'in' 检查来区分「未传递」和「显式传递 undefined」
    if ('claudeCode' in models) {
      this.config.claudeCode = models.claudeCode
        ? { ...this.config.claudeCode, ...models.claudeCode }
        : undefined;
    }
    if ('codeBuddyModels' in models) this.config.codeBuddyModels = models.codeBuddyModels;
    if ('workbuddyModels' in models) this.config.workbuddyModels = models.workbuddyModels;
    if ('hermesModel' in models) this.config.hermesModel = models.hermesModel;
    if ('codexModel' in models) this.config.codexModel = models.codexModel;
    if ('toolModels' in models) {
      this.config.toolModels = models.toolModels
        ? { ...this.config.toolModels, ...models.toolModels }
        : undefined;
    }
    if ('defaultModel' in models) this.config.defaultModel = models.defaultModel;
    this.save();
  }

  // 根据当前线路获取 base URL
  get baseUrl(): string {
    const endpoint = this.getEndpoint();
    if (endpoint === CUSTOM_ENDPOINT && this.config.base_url) return this.config.base_url.replace(/\/+$/, '');
    return getBaseUrl(endpoint);
  }

  // ─── 上下文大小 ───

  // 某个工具的上下文上限；不传工具名时返回全局值
  getContextWindow(toolName?: string): number | undefined {
    this.load();
    const own = toolName ? this.config.context_windows?.[toolName] : undefined;
    return own || this.config.context_window || undefined;
  }

  // 只设置指定的工具；undefined 表示改回「自动」（模型上限）
  setContextWindow(tokens: number | undefined, toolNames: string[]): void {
    this.load();
    const map = { ...this.config.context_windows };
    for (const name of toolNames) {
      if (tokens) map[name] = tokens;
      else delete map[name];
    }
    // 旧版全局值迁移成按工具保存，避免它继续影响没选中的工具
    if (this.config.context_window) {
      delete this.config.context_window;
    }
    this.config.context_windows = Object.keys(map).length ? map : undefined;
    if (!this.config.context_windows) delete this.config.context_windows;
    this.save();
  }

  // 写入前的快照：模型与上下文，用于「查看改动」预演后恢复
  snapshotToolSettings(): string {
    this.load();
    const { claudeCode, codeBuddyModels, workbuddyModels, hermesModel, codexModel, toolModels, defaultModel, context_windows, context_window } = this.config;
    return JSON.stringify({ claudeCode, codeBuddyModels, workbuddyModels, hermesModel, codexModel, toolModels, defaultModel, context_windows, context_window });
  }

  restoreToolSettings(snapshot: string): void {
    this.load();
    const saved = JSON.parse(snapshot) as Partial<Config>;
    for (const key of ['claudeCode', 'codeBuddyModels', 'workbuddyModels', 'hermesModel', 'codexModel', 'toolModels', 'defaultModel', 'context_windows', 'context_window'] as const) {
      if (saved[key] === undefined) delete this.config[key];
      else (this.config as Record<string, unknown>)[key] = saved[key];
    }
    this.save();
  }

  // ─── 配置档 ───

  getActiveProfile(): string | undefined {
    this.load();
    const name = this.config.profile;
    return name && this.config.profiles?.[name] ? name : undefined;
  }

  listProfiles(): Profile[] {
    this.load();
    return Object.entries(this.config.profiles ?? {}).map(([name, p]) => toProfile(name, p));
  }

  getProfile(name: string): Profile | undefined {
    this.load();
    const entry = this.config.profiles?.[name];
    return entry ? toProfile(name, entry) : undefined;
  }

  saveProfile(name: string, apiKey: string, endpoint: string, baseUrl?: string): void {
    this.load();
    this.config.profiles = {
      ...this.config.profiles,
      [name]: { api_key: apiKey, endpoint, ...(endpoint === CUSTOM_ENDPOINT && baseUrl ? { base_url: baseUrl.replace(/\/+$/, '') } : {}) },
    };
    // 正在用的配置档被修改时，顶层连接一起更新
    if (this.config.profile === name) this.copyProfileToTop(name);
    this.save();
  }

  removeProfile(name: string): void {
    this.load();
    if (!this.config.profiles?.[name]) return;
    delete this.config.profiles[name];
    if (Object.keys(this.config.profiles).length === 0) delete this.config.profiles;
    if (this.config.profile === name) delete this.config.profile;
    for (const [tool, profile] of Object.entries(this.config.tool_profiles ?? {})) {
      if (profile === name) delete this.config.tool_profiles![tool];
    }
    this.save();
  }

  // 切换当前配置档：顶层连接改为它，取消所有工具的单独绑定
  useProfile(name: string): void {
    this.load();
    if (!this.config.profiles?.[name]) throw new Error(`Profile not found: ${name}`);
    this.config.profile = name;
    this.copyProfileToTop(name);
    delete this.config.tool_profiles;
    this.save();
  }

  getToolProfile(toolName: string): string | undefined {
    this.load();
    const name = this.config.tool_profiles?.[toolName];
    return name && this.config.profiles?.[name] ? name : undefined;
  }

  // 把单个工具绑定到某个配置档；与当前配置档相同或传 undefined 时解除绑定
  setToolProfile(toolName: string, name: string | undefined): void {
    this.load();
    const tools = { ...this.config.tool_profiles };
    if (name && name !== this.config.profile) tools[toolName] = name;
    else delete tools[toolName];
    this.config.tool_profiles = Object.keys(tools).length ? tools : undefined;
    if (!this.config.tool_profiles) delete this.config.tool_profiles;
    this.save();
  }

  // 工具实际使用的连接：单独绑定了配置档的用它，否则用当前连接
  getConnection(toolName?: string): Connection {
    const pinned = toolName ? this.getToolProfile(toolName) : undefined;
    if (pinned) {
      const p = this.getProfile(pinned)!;
      return { apiKey: p.apiKey, endpoint: p.endpoint, baseUrl: p.baseUrl, profile: pinned };
    }
    return { apiKey: this.getApiKey(), endpoint: this.getEndpoint(), baseUrl: this.baseUrl, profile: this.getActiveProfile() };
  }

  private copyProfileToTop(name: string): void {
    const p = this.config.profiles![name];
    this.config.api_key = p.api_key;
    this.config.endpoint = p.endpoint;
    if (p.base_url) this.config.base_url = p.base_url;
    else delete this.config.base_url;
  }

  // 修改当前 Key / 线路时，同步写回当前配置档
  private syncActiveProfile(): void {
    const name = this.config.profile;
    if (!name || !this.config.profiles?.[name] || !this.config.api_key) return;
    this.config.profiles[name] = {
      api_key: this.config.api_key,
      endpoint: this.config.endpoint || DEFAULT_ENDPOINT,
      ...(this.config.base_url ? { base_url: this.config.base_url } : {}),
    };
  }

  // 获取配置目录路径
  get configDir(): string {
    return CONFIG_DIR;
  }

  // 获取配置文件路径
  get configFile(): string {
    return CONFIG_FILE;
  }
}

function toProfile(name: string, entry: ProfileEntry): Profile {
  const endpoint = normalizeEndpointId(entry.endpoint || DEFAULT_ENDPOINT);
  const baseUrl = endpoint === CUSTOM_ENDPOINT && entry.base_url ? entry.base_url : getBaseUrl(endpoint);
  return { name, apiKey: entry.api_key, endpoint, baseUrl };
}

// 导出单例
export const configManager = new ConfigManager();
