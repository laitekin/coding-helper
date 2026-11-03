import assert from 'node:assert/strict'; import test from 'node:test'; import { runPrompt } from './helpers/prompt-pty.mjs';

// 工具数量口径：「已接入 x / y」只统计可持久配置的工具；只能启动接入的工具（Copilot）单独说明，不计入分母也不计入分子
const head = (connectAll) => `const {i18n}=await import('./dist/lib/i18n.js');i18n.init('zh_CN');const {configManager}=await import('./dist/lib/config.js');configManager.setApiKey('sk-demo1234567890abcd');
const {toolManager}=await import('./dist/lib/tool-manager.js');
for (const tool of toolManager.getAll()) { tool.isInstalled=()=>false; tool.getVersion=()=>null; ${connectAll ? 'tool.isConfigured=()=>!tool.launchOnly;' : 'tool.isConfigured=()=>false;'} }
const all=toolManager.getAll();const launchOnly=all.filter(t=>t.launchOnly);
console.log('COUNTS',JSON.stringify({total:all.length,configurable:all.length-launchOnly.length,launchOnly:launchOnly.map(t=>t.displayName)}));
const {showMainMenu}=await import('./dist/lib/wizard/menus/main-menu.js');await showMainMenu();`;
const counts = out => JSON.parse(out.match(/COUNTS (.*)/)[1]);

test('real PTY main menu separates configurable tools from launch-only tools', { skip: process.platform === 'win32' }, async () => {
  const out = await runPrompt(head(false), [[/Esc 退出/, '\x1b']], 120, { rows: 32 });
  const { total, configurable, launchOnly } = counts(out);
  assert.deepEqual(launchOnly, ['GitHub Copilot CLI']);
  assert.equal(configurable + launchOnly.length, total);
  // 状态栏：分母为可配置的工具数，另注明启动接入的数量
  assert.match(out, new RegExp(`已接入 0 / ${configurable} +· +另 ${launchOnly.length} 款启动接入`));
  // 主菜单「我的工具」：同样的分母，并写明哪个工具是启动接入
  assert.match(out, new RegExp(`我的工具 +0 / ${configurable} 已接入 · GitHub Copilot CLI 启动接入`));
});

test('real PTY main menu reaches full count once every configurable tool is connected', { skip: process.platform === 'win32' }, async () => {
  const out = await runPrompt(head(true), [[/Esc 退出/, '\x1b']], 120, { rows: 32 });
  const { configurable } = counts(out);
  assert.match(out, new RegExp(`已接入 ${configurable} / ${configurable}`));
  assert.match(out, new RegExp(`我的工具 +${configurable} / ${configurable} 已接入`));
});

test('real PTY My tools marks launch-only tools with their launch command', { skip: process.platform === 'win32' }, async () => {
  // Copilot 已安装时排在最前、默认选中，下方显示启动命令；列表徽标为「▸ 启动接入」而不是「○ 未接入」
  const src = head(false).replace("const all=toolManager.getAll()", "toolManager.get('copilot').isInstalled=()=>true;const all=toolManager.getAll()");
  const out = await runPrompt(src, [[/Esc 退出/, '\x1b[B\x1b[B'], [/❯ +(?:\S+ )?我的工具/, '\r'], [/启动方式[^]*搜索/, '\x1b'], [/Esc 退出/, '\x1b']], 120, { rows: 40 });
  const page = out.slice(out.indexOf('「已接入」'));
  assert.match(page, /「已接入」只统计写入配置文件的工具/);
  assert.match(page, /GitHub Copilot CLI +已安装 +▸ 启动接入/);
  assert.match(page, /启动方式 +coding-helper run copilot/);
  // 其他工具仍是「○ 未接入」，不带启动接入标记
  assert.match(page, /Claude Code +未安装 +○ 未接入/);
});

// 标语的工具数取自注册表：= 可配置的工具数 + 启动接入的工具数，与状态栏口径一致
test('header tagline counts every registered tool, configurable plus launch-only', { skip: process.platform === 'win32' }, async () => {
  const out = await runPrompt(head(false), [[/Esc 退出/, '\x1b']], 120, { rows: 40 });
  const { total, configurable, launchOnly } = counts(out);
  assert.match(out, new RegExp(`${total} 款编程助手`));
  assert.equal(total, configurable + launchOnly.length);
});
