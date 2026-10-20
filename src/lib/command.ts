import { profileAddCommand, profileListCommand, profileRemoveCommand, profileUseCommand } from '../commands/profile.js';
import { Command } from 'commander';
import {
  authCommand,
  doctorCommand,
  langShowCommand,
  langSetCommand,
  setupCommand,
  statusCommand,
  restoreCommand,
  runCommand,
  quickCommand,
  isQuickTarget,
  shortName,
} from '../commands/index.js';
import { Wizard } from './wizard/wizard.js';
import { i18n, t } from './i18n.js';
import { toolManager } from './tool-manager.js';
import { showToolMenu } from './wizard/menus/tool-menu.js';
import { showMainMenu } from './wizard/menus/main-menu.js';
import { VERSION } from './version.js';

function resolveToolName(tool: string): string {
  if (tool === 'claude' || tool === 'claude-code') return 'claude-code';
  if (tool === 'codex' || tool === 'openai-codex') return 'codex';
  return tool;
}

// 创建并配置 Commander 程序
export function createProgram(): Command {
  const program = new Command();
  // run 子命令需要把选项原样传给被启动的工具
  program.enablePositionalOptions();

  program
    .name('coding-helper')
    .description('CLI tool for configuring AI coding assistants with Qiniu API endpoints')
    .version(VERSION);

  // 默认行为（无子命令）：首次运行触发向导，否则进入主菜单
  // 第一个参数是工具名或 all 时走单条命令：coding-helper codex sk-xxx [模型]
  program
    .argument('[tool]', 'tool name(s) or "all" for one-command setup, e.g. codex or claude,codex')
    .argument('[args...]', 'API key (sk-...) and/or model ID')
    .option('--intl', 'use the international endpoint')
    .option('--dry-run', 'show what would change without writing any file')
    .option('--json', 'print results as JSON')
    .option('--no-save', 'do not save the key and model to ~/.coding-helper/config.yaml')
    .option('--context <size>', 'context size limit, e.g. 128k (auto = model maximum)')
    .action(async (tool: string | undefined, args: string[], options: { intl?: boolean; dryRun?: boolean; json?: boolean; save?: boolean; context?: string }) => {
      if (tool) {
        if (!isQuickTarget(tool)) {
          i18n.init();
          console.error(t('quick_unknown_tool', {
            tool,
            tools: toolManager.getAll().map(shortName).join(', '),
          }));
          process.exitCode = 1;
          return;
        }
        await quickCommand(tool, args, options);
        return;
      }
      const wizard = new Wizard();
      await wizard.run();
    });

  // profile - 配置档：多个 Key / 线路之间切换
  const profile = program
    .command('profile')
    .description('Manage profiles (API key + endpoint sets)');
  profile
    .command('list', { isDefault: true })
    .description('List profiles')
    .option('--json', 'print as JSON')
    .action((options: { json?: boolean }) => profileListCommand(options));
  profile
    .command('add <name> [key]')
    .description('Add or update a profile (key from argument, --key-stdin or QINIU_API_KEY)')
    .option('--intl', 'use the international endpoint')
    .option('--base-url <url>', 'use a custom Qiniu-compatible base URL')
    .option('--key-stdin', 'read the API key from stdin')
    .option('--use', 'switch to this profile after adding')
    .action(async (name: string, key: string | undefined, options: { intl?: boolean; baseUrl?: string; keyStdin?: boolean; use?: boolean }) => {
      await profileAddCommand(name, key, options);
    });
  profile
    .command('use <name> [tools]')
    .description('Switch the active profile, or bind only the given tools (comma separated) to it')
    .option('--sync', 'also rewrite every connected tool with the new profile (default: ask in a terminal, otherwise only switch)')
    .action(async (name: string, tools: string | undefined, options: { sync?: boolean }) => {
      await profileUseCommand(name, tools, options);
    });
  profile
    .command('remove <name>')
    .alias('rm')
    .description('Remove a profile')
    .action(async (name: string) => {
      await profileRemoveCommand(name);
    });

  // init - 强制重新初始化
  program
    .command('init')
    .description('Run initialization wizard')
    .action(async () => {
      const wizard = new Wizard();
      i18n.init();
      await wizard.runInitWizard();
      await wizard.runMainMenu();
    });

  // setup - 批量配置本机编码工具（非交互可用于脚本与 CI）
  program
    .command('setup')
    .description('Configure all installed coding tools in one go')
    .option('--tools <list>', 'comma-separated tools to configure, e.g. claude,codex')
    .option('-y, --yes', 'skip prompts and use saved or default models')
    .option('--json', 'print results as JSON')
    .option('--key-stdin', 'read the API Key from stdin instead of saved config')
    .option('--dry-run', 'show what would change without writing any file')
    .action(async (options: { tools?: string; yes?: boolean; json?: boolean; keyStdin?: boolean; dryRun?: boolean }) => {
      await setupCommand(options);
    });

  // status - 查看各编码工具的接入状态
  program
    .command('status')
    .description('Show whether each coding tool points to Qiniu')
    .option('--json', 'print status as JSON')
    .action(async (options: { json?: boolean }) => {
      await statusCommand(options);
    });

  // restore - 移除七牛配置并还原原值
  program
    .command('restore [tools]')
    .description('Remove Qiniu config from coding tools and restore previous values')
    .option('-y, --yes', 'skip confirmation')
    .action(async (tools: string | undefined, options: { yes?: boolean }) => {
      await restoreCommand(tools, options);
    });

  // run - 启动器模式：只给子进程注入七牛环境变量，不改配置文件
  program
    .command('run <tool> [args...]')
    .description('Launch a coding tool with Qiniu settings injected, without touching its config')
    .allowUnknownOption()
    .passThroughOptions()
    .action(async (tool: string, args: string[] = []) => {
      await runCommand(tool, args);
    });

  // auth - API Key 管理
  program
    .command('auth [token]')
    .description('Manage API Key')
    .option('--sync', 'also rewrite connected tools with the new key (default: ask in a terminal, otherwise only save)')
    .action(async (token: string | undefined, options: { sync?: boolean }) => {
      await authCommand(token, options);
    });

  // doctor - 健康检查
  program
    .command('doctor')
    .description('Run health check')
    .action(async () => {
      await doctorCommand();
    });

  // lang - 语言管理
  const langCmd = program
    .command('lang')
    .description('Manage language settings');

  langCmd
    .command('show')
    .description('Show current language')
    .action(() => {
      langShowCommand();
    });

  langCmd
    .command('set <locale>')
    .description('Set language (zh_CN / en_US)')
    .action((locale: string) => {
      langSetCommand(locale);
    });

  // enter - 进入菜单
  program
    .command('enter [tool]')
    .description('Enter main menu or tool configuration')
    .action(async (tool?: string) => {
      i18n.init();

      if (tool) {
        // 处理工具名称别名
        const toolName = resolveToolName(tool);
        const toolInstance = toolManager.get(toolName);
        if (toolInstance) {
          await showToolMenu(toolInstance);
        } else {
          console.error(`Unknown tool: ${tool}`);
          process.exit(1);
        }
      } else {
        await showMainMenu();
      }
    });

  return program;
}
