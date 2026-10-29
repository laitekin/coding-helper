import { spawn } from 'node:child_process';
import { t, i18n } from '../lib/i18n.js';
import { configManager } from '../lib/config.js';
import { toolManager } from '../lib/tool-manager.js';
import { uiRenderer } from '../lib/wizard/ui/ui-renderer.js';

// 只向子进程注入配置，不修改客户端文件；参数以数组传递，不能交给 shell 解释
export async function runCommand(toolName: string, args: string[]): Promise<void> {
  i18n.init();
  const tool = toolManager.get(toolName);
  if (!tool?.getLaunchEnv) {
    uiRenderer.renderError(t('run_unsupported', { tool: toolName }));
    uiRenderer.renderHint(t('run_supported_tools', { tools: toolManager.getAll().filter(item => item.getLaunchEnv).map(item => item.name).join(', ') }));
    process.exitCode = 1; return;
  }
  const apiKey = configManager.getApiKey();
  if (!apiKey) { uiRenderer.renderError(t('apikey_not_set')); process.exitCode = 1; return; }
  try {
    const variables = tool.getLaunchEnv(apiKey, configManager.baseUrl, configManager.getModels());
    if (tool.isInstalled() === false) throw new Error(t('tool_not_installed', { tool: tool.displayName, command: tool.installCommand }));
    const passArgs = args[0] === '--' ? args.slice(1) : args;
    const child = spawn(tool.command, passArgs, { stdio: 'inherit', env: { ...process.env, ...variables }, shell: false });
    const interrupt = () => { child.kill('SIGINT'); };
    const terminate = () => { child.kill('SIGTERM'); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1); resolve(); });
      });
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  } catch (error) { uiRenderer.renderError(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
