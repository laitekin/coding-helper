import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import type { ITool } from './base-tool.js';
import { configManager, type ModelConfig } from '../config.js';
import { isQiniuBaseUrl } from '../endpoints.js';
import { t } from '../i18n.js';
import { assertNotSymlink, readTextFile, readJsonSnapshot, readJsonObjectStrict, safeWriteFile, writeJsonOrRemove, formatJsonLike } from '../core/safe-write.js';
import { stateStore, type ToolState, type PriorValues } from '../core/state-store.js';
import { runModelSelectionFlow } from '../wizard/flows/model-selection-flow.js';
import { uiRenderer } from '../wizard/ui/ui-renderer.js';

// API 超时时间：50 分钟，适配长时间推理请求
const API_TIMEOUT = '3000000';

// Claude Code 的环境变量 key 列表
const CLAUDE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
];

// Claude Code 配置文件路径
const CLAUDE_SETTINGS_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_SETTINGS_FILE = path.join(CLAUDE_SETTINGS_DIR, 'settings.json');
const CLAUDE_JSON_FILE = path.join(os.homedir(), '.claude.json');

// Claude Code 工具实现
export class ClaudeCodeTool implements ITool {
  name = 'claude-code';
  displayName = 'Claude Code';
  command = 'claude';
  installCommand = 'npm install -g @anthropic-ai/claude-code';
  updateCommand = 'claude update';
  npmPackageName = '@anthropic-ai/claude-code';
  aliases = ['claude'];

  // 获取已安装的 Claude Code 版本
  getVersion(): string | null {
    try {
      const output = execSync('claude --version', { stdio: 'pipe', encoding: 'utf-8' }).trim();
      // 提取语义化版本号（兼容 "1.0.23" 或 "claude v1.0.23" 等格式）
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : output;
    } catch {
      return null;
    }
  }

  // 检查 claude 命令是否可用
  isInstalled(): boolean {
    try {
      const command = process.platform === 'win32' ? 'where claude' : 'which claude';
      execSync(command, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  // 读取当前 Claude Code settings.json
  getConfig(): Record<string, unknown> {
    try {
      return readJsonObjectStrict(CLAUDE_SETTINGS_FILE);
    } catch {
      // 文件不存在或解析失败
    }
    return {};
  }

  // 卸载只处理本工具记录过的字段，保留之后的用户编辑
  clearModelConfig(): void {
    stateStore.withLock(() => {
      const targets = [CLAUDE_SETTINGS_FILE, CLAUDE_JSON_FILE];
      const unrecorded = targets.filter(file => !stateStore.getState(this.name, file));
      const exists = unrecorded.some(file => {
        try { fs.lstatSync(file); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      });
      if (exists) throw new Error('No restoration record for existing Claude configuration. Configuration is unchanged; remove legacy credentials manually or recover a known backup.');
      const plans: ConfigPlan[] = [];
      for (const file of targets) {
        if (!stateStore.getState(this.name, file)) continue;
        assertNotSymlink(file);
        const current = readJsonSnapshot(file);
        const saved = checkedState(recoverPending(this.name, file, current.content), file === CLAUDE_SETTINGS_FILE);
        if (!saved) continue;
        const original = originalConfig(saved);
        const manageModel = saved.priors!.manageModel === true;
        const next = restoreConfig(current.value, saved.priors!.snapshot as PriorValues, saved.applied!, file === CLAUDE_SETTINGS_FILE, manageModel);
        const content = current.content === undefined ? undefined
          : isDeepStrictEqual(next, original.value) ? original.content
          : formatJsonLike(current.content, next);
        plans.push({ file, before: current.content, after: content, previous: saved });
      }
      commitConfigs(this.name, plans);
    });
  }

  // 两个文件先全部解析和校验；任何写入失败时还原本轮已提交的文件及状态
  async loadConfig(apiKey: string, baseUrl: string, models: ModelConfig): Promise<void> {
    stateStore.withLock(() => {
      if (stateStore.getState(this.name)) throw new Error('Legacy Claude restoration state requires recovery from backup.');
      const selected = models.claudeCode || {};
      const clearSelection = !selected.useDefaultModels && !!selected.sonnetModel;
      const plans: ConfigPlan[] = [];
      for (const file of [CLAUDE_SETTINGS_FILE, CLAUDE_JSON_FILE]) {
        assertNotSymlink(file);
        const current = readJsonSnapshot(file);
        const settingsFile = file === CLAUDE_SETTINGS_FILE;
        const previous = checkedState(recoverPending(this.name, file, current.content), file === CLAUDE_SETTINGS_FILE);
        const env = current.value.env;
        if (settingsFile && !previous && isRecord(env) && isQiniuBaseUrl(env.ANTHROPIC_BASE_URL) &&
            typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN) {
          throw new Error('Legacy Claude credentials have no restoration record. Configuration is unchanged; remove legacy credentials manually or recover a known backup before loading.');
        }
        const managedBefore = previous?.priors?.manageModel === true;
        const beforeSnapshot = snapshot(current.value, settingsFile, managedBefore);
        if (previous) {
          const expected = { ...previous.applied };
          // 显式切换模型允许清掉刚在 /model 选过的值，其他字段的编辑仍受保护
          if (clearSelection && settingsFile) { delete beforeSnapshot.model; delete expected.model; }
          if (!isDeepStrictEqual(beforeSnapshot, expected)) throw new Error('Claude managed fields changed since loading. Unload before reloading.');
        }
        const manageModel = settingsFile && (managedBefore || clearSelection);
        const next = structuredClone(current.value);
        if (settingsFile) {
          const env: Record<string, unknown> = { ...(isRecord(next.env) ? next.env : {}) };
          for (const key of CLAUDE_ENV_KEYS) if (key !== 'ANTHROPIC_MODEL' || clearSelection) delete env[key];
          Object.assign(env, {
            ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey, API_TIMEOUT_MS: API_TIMEOUT,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
          });
          if (selected.haikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = selected.haikuModel;
          if (selected.sonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = selected.sonnetModel;
          if (selected.opusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = selected.opusModel;
          if (selected.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = selected.subagentModel;
          next.env = env;
          if (clearSelection) delete next.model;
          next.companyAnnouncements = [t('company_announcement')];
          next.attribution = { commit: '', pr: '' };
        } else next.hasCompletedOnboarding = true;
        const original = previous ? originalConfig(previous) : current;
        const priors = { content: original.content ?? null, snapshot: snapshot(original.value, settingsFile, manageModel), manageModel };
        plans.push({ file, before: current.content, after: formatJsonLike(current.content, next), previous,
          next: { priors, applied: snapshot(next, settingsFile, manageModel) } });
      }
      commitConfigs(this.name, plans);
    });
  }

  // 启动器沿用相同环境配置，清掉父进程可能遗留的模型覆盖
  getLaunchEnv(apiKey: string, baseUrl: string, models: ModelConfig): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = Object.fromEntries(CLAUDE_ENV_KEYS.map(key => [key, undefined]));
    Object.assign(env, { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey, API_TIMEOUT_MS: API_TIMEOUT,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_ATTRIBUTION_HEADER: '0' });
    const selected = models.claudeCode || {};
    if (selected.haikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = selected.haikuModel;
    if (selected.sonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = selected.sonnetModel;
    if (selected.opusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = selected.opusModel;
    if (selected.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = selected.subagentModel;
    return env;
  }

  // 从 Claude Code 移除配置
  unloadConfig(): void {
    this.clearModelConfig();
  }

  async runModelConfigFlow(): Promise<boolean> {
    return runModelSelectionFlow();
  }

  renderModelConfigSummary(): void {
    const claudeCode = configManager.getModels().claudeCode || {};
    uiRenderer.renderModelConfigItem(t('config_view_haiku'), claudeCode.haikuModel);
    uiRenderer.renderModelConfigItem(t('config_view_sonnet'), claudeCode.sonnetModel);
    uiRenderer.renderModelConfigItem(t('config_view_opus'), claudeCode.opusModel);
    uiRenderer.renderModelConfigItem(t('config_view_subagent'), claudeCode.subagentModel);
  }

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 缺失字段不存入快照，从而与显式 null 区分
function snapshot(config: Record<string, unknown>, settings: boolean, model: boolean): PriorValues {
  const result: PriorValues = {};
  if (settings && Object.hasOwn(config, 'env')) {
    if (!isRecord(config.env)) throw new Error('Invalid Claude env: expected an object.');
    result.env = Object.fromEntries(CLAUDE_ENV_KEYS.filter(key => Object.hasOwn(config.env!, key)).map(key => [key, (config.env as PriorValues)[key]]));
  }
  for (const key of settings ? ['companyAnnouncements', 'attribution', ...(model ? ['model'] : [])] : ['hasCompletedOnboarding']) {
    if (Object.hasOwn(config, key)) result[key] = structuredClone(config[key]);
  }
  return result;
}

function originalConfig(saved: ToolState): { content: string | undefined; value: Record<string, unknown> } {
  const content = saved.priors!.content as string | null;
  const value: unknown = content === null ? {} : JSON.parse(content);
  if (!isRecord(value)) throw new Error('Invalid Claude restoration content.');
  return { content: content ?? undefined, value };
}

function recoverPending(tool: string, file: string, content: string | undefined): ToolState | undefined {
  const saved = stateStore.getState(tool, file);
  if (!saved?.pending) return saved;
  let recovered: ToolState | undefined;
  if (content === saved.pending.after) recovered = { priors: saved.priors, applied: saved.pending.applied };
  else if ((content ?? null) === saved.pending.before) recovered = saved.applied ? { priors: saved.priors, applied: saved.applied } : undefined;
  else throw new Error('Claude configuration changed during an interrupted write; restoration journal retained.');
  stateStore.setState(tool, recovered, file);
  return recovered;
}

function checkedState(saved: ToolState | undefined, settings: boolean): ToolState | undefined {
  if (saved && (!isRecord(saved.priors?.snapshot) || !isRecord(saved.applied) ||
      !(saved.priors.content === null || typeof saved.priors.content === 'string') ||
      typeof saved.priors.manageModel !== 'boolean')) {
    throw new Error('Claude restoration state is incomplete. Restore from backup before retrying.');
  }
  if (saved) {
    const original = originalConfig(saved);
    const model = saved.priors!.manageModel === true;
    if (!isDeepStrictEqual(snapshot(original.value, settings, model), saved.priors!.snapshot) ||
        !isDeepStrictEqual(snapshot(saved.applied!, settings, model), saved.applied)) {
      throw new Error('Claude restoration snapshot is inconsistent. Restore from backup before retrying.');
    }
  }
  return saved;
}

// 三方还原仅撤销仍等于上次写入值的键，后续手动编辑保留
function restoreConfig(config: Record<string, unknown>, prior: PriorValues, applied: PriorValues, settings: boolean, model: boolean): Record<string, unknown> {
  const next = structuredClone(config);
  const current = snapshot(config, settings, model);
  const restore = (target: PriorValues, key: string, original: PriorValues, written: PriorValues): void => {
    const own = (object: PriorValues) => Object.hasOwn(object, key) ? object[key] : undefined;
    if (!isDeepStrictEqual(own(target), own(written))) return;
    if (Object.hasOwn(original, key)) target[key] = structuredClone(original[key]);
    else delete target[key];
  };
  for (const key of new Set([...Object.keys(prior), ...Object.keys(applied)])) {
    if (key === 'env' && isRecord(next.env)) {
      for (const envKey of CLAUDE_ENV_KEYS) restore(next.env, envKey, isRecord(prior.env) ? prior.env : {}, isRecord(applied.env) ? applied.env : {});
      if (!Object.keys(next.env).length && !Object.hasOwn(prior, 'env')) delete next.env;
    } else if (key !== 'env') {
      restore(current, key, prior, applied);
      if (Object.hasOwn(current, key)) next[key] = current[key];
      else delete next[key];
    }
  }
  return next;
}

interface ConfigPlan { file: string; before: string | undefined; after: string | undefined; previous?: ToolState; next?: ToolState; }

function commitConfigs(tool: string, plans: ConfigPlan[]): void {
  const saved: ConfigPlan[] = [];
  const written: ConfigPlan[] = [];
  const write = (file: string, content: string | undefined, expected: string | undefined): void => {
    if (content === undefined) writeJsonOrRemove(file, {}, { content: expected });
    else safeWriteFile(file, content, 0o600, { content: expected });
  };
  try {
    // 先保存装载快照，卸载记录只在两份文件都成功后清除
    for (const plan of plans) if (plan.next) {
      saved.push(plan);
      stateStore.setState(tool, { priors: plan.next.priors, applied: plan.previous?.applied,
        pending: { before: plan.before ?? null, after: plan.after!, applied: plan.next.applied! } }, plan.file);
    }
    for (const plan of plans) {
      try { write(plan.file, plan.after, plan.before); }
      catch (error) { if (readTextFile(plan.file) === plan.after) written.push(plan); throw error; }
      written.push(plan);
    }
    for (const plan of plans) {
      if (plan.next) stateStore.setState(tool, plan.next, plan.file);
      else { saved.push(plan); stateStore.markRemoved(tool, plan.file); }
    }
  } catch (error) {
    const failures: unknown[] = [];
    const restored = new Set<ConfigPlan>();
    for (const plan of [...written].reverse()) {
      try { write(plan.file, plan.before, plan.after); restored.add(plan); } catch (err) { failures.push(err); }
    }
    // 回滚文件失败时保留恢复记录，避免失去唯一原值
    for (const plan of [...saved].reverse()) {
      // An unload may already have deleted a record before a later cleanup fails.
      // Restore those records even if rolling client files back also failed.
      if (!plan.next || !written.includes(plan) || restored.has(plan)) {
        try { stateStore.setState(tool, plan.previous, plan.file); } catch (err) { failures.push(err); }
      }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'Claude configuration recovery failed. Restore from backup before retrying.');
    throw error;
  }
}
