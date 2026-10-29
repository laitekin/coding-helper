import spawn from 'cross-spawn';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { findCommand } from '../utils/find-command.js';
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
  let temporary: string | undefined;
  try {
    const variables = tool.getLaunchEnv(apiKey, configManager.baseUrl, configManager.getModels());
    if (tool.isInstalled() === false) throw new Error(t('tool_not_installed', { tool: tool.displayName, command: tool.installCommand }));
    let passArgs = args[0] === '--' ? args.slice(1) : args;
    if (tool.getLaunchSettings) {
      if (passArgs.some(arg => arg === '--settings' || arg.startsWith('--settings='))) throw new Error('The launcher manages session settings; do not pass --settings.');
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-helper-launch-'));
      const settings = path.join(temporary, 'settings.json');
      fs.writeFileSync(settings, JSON.stringify(tool.getLaunchSettings(apiKey, configManager.baseUrl, configManager.getModels())), {mode:0o600});
      passArgs = ['--settings', settings, ...passArgs];
    }
    const child = spawn(findCommand(tool.command, tool.searchPaths) ?? tool.command, passArgs, { stdio: 'inherit', env: { ...process.env, ...variables }, shell: false });
    // POSIX 前台子进程已由终端进程组收到 Ctrl-C，不能重复转发。
    const interrupt = () => { if (process.platform === 'win32') child.kill('SIGINT'); };
    const terminate = () => { child.kill('SIGTERM'); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => { const number = signal ? os.constants.signals[signal as keyof typeof os.constants.signals] : undefined; process.exitCode = code ?? (number ? 128 + number : 1); resolve(); });
      });
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  } catch (error) { uiRenderer.renderError(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  finally { if (temporary) fs.rmSync(temporary, {recursive:true,force:true}); }
}
