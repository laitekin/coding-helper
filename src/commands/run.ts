import { spawn } from 'node:child_process';
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

  const apiKey = configManager.getApiKey();
  if (!apiKey) {
    uiRenderer.renderError(t('setup_apikey_missing'));
    process.exitCode = 1;
    return;
  }

  let env: Record<string, string>;
  try {
    env = tool.getLaunchEnv(apiKey, configManager.baseUrl, configManager.getModels());
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
  const passArgs = args[0] === '--' ? args.slice(1) : args;
  const child = spawn(tool.command, passArgs, {
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
