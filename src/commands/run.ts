import { spawn } from 'node:child_process';
import { findCommand } from '../utils/find-command.js';
import { t, i18n } from '../lib/i18n.js';
import { configManager } from '../lib/config.js';
import { toolManager } from '../lib/tool-manager.js';
import { uiRenderer } from '../lib/wizard/ui/ui-renderer.js';

// 可通过启动器使用的工具名称列表
function launchableTools(): string {
  return toolManager.getAll().filter((tool) => tool.getLaunchEnv).map((tool) => tool.name).join(', ');
}

// run 命令：只给子进程注入七牛环境变量，不改任何配置文件
export async function runCommand(toolName: string, args: string[]): Promise<void> {
  i18n.init();
  const tool = toolManager.get(toolName);
  if (!tool?.getLaunchEnv) {
    uiRenderer.renderError(t('run_unsupported', { tool: toolName }));
    uiRenderer.renderHint(t('run_supported_tools', { tools: launchableTools() }));
    process.exitCode = 1;
    return;
  }

  // run <tool> @配置档 [参数…]：本次启动使用该配置档
  let rest = args;
  let connection = configManager.getConnection(tool.name);
  if (rest[0]?.startsWith('@')) {
    const profile = configManager.getProfile(rest[0].slice(1));
    if (!profile) {
      uiRenderer.renderError(t('quick_profile_not_found', { name: rest[0].slice(1) }));
      process.exitCode = 1;
      return;
    }
    connection = { apiKey: profile.apiKey, endpoint: profile.endpoint, baseUrl: profile.baseUrl, profile: profile.name };
    rest = rest.slice(1);
  }
  const apiKey = connection.apiKey;
  if (!apiKey) {
    uiRenderer.renderError(t('setup_apikey_missing'));
    process.exitCode = 1;
    return;
  }

  let env: Record<string, string>;
  try {
    env = tool.getLaunchEnv(apiKey, connection.baseUrl, configManager.getModels());
  } catch (err: unknown) {
    uiRenderer.renderError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  if (tool.isInstalled() === false) {
    uiRenderer.renderError(t('tool_not_installed', { tool: tool.displayName, command: tool.installCommand }));
    process.exitCode = 1;
    return;
  }

  // 兼容 `run claude -- --continue` 写法：去掉分隔用的 --
  const passArgs = rest[0] === '--' ? rest.slice(1) : rest;
  // Windows 下 .cmd 需走 shell，直接用命令名
  const file = process.platform === 'win32' ? tool.command : findCommand(tool.command, tool.searchPaths) ?? tool.command;
  const child = spawn(file, passArgs, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });

  // 把 Ctrl+C 等信号交给子进程处理，自身不提前退出
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);

  await new Promise<void>((resolve) => {
    child.on('error', (err) => {
      uiRenderer.renderError(err.message);
      process.exitCode = 1;
      resolve();
    });
    child.on('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
      resolve();
    });
  });
  process.off('SIGINT', forward);
  process.off('SIGTERM', forward);
}
