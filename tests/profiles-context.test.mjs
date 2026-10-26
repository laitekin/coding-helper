import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-helper-profiles-'));

const { configManager } = await import('../dist/lib/config.js');
const { isQiniuBaseUrl } = await import('../dist/lib/endpoints.js');
const { parseContextSize, formatContextSize, isValidProfileName, parseQuickArgs } = await import('../dist/lib/core/quick-args.js');
const { mergeCodexProfiles, buildCodexProfileFile, codexProfileName } = await import('../dist/lib/tools/codex-tool.js');
const { SPRITES, spriteGrid, logoGrid, renderGrid, joinBlocks } = await import('../dist/lib/wizard/ui/pixel.js');
const { maskSecret } = await import('../dist/lib/wizard/ui/prompts.js');

const strip = (s) => s.replace(/\x1B\[[0-9;]*m/g, '');

// ---- 纯函数 ----

test('parseContextSize understands k / m / plain numbers and auto', () => {
  assert.equal(parseContextSize('128k'), 128000);
  assert.equal(parseContextSize('1M'), 1000000);
  assert.equal(parseContextSize('96000'), 96000);
  assert.equal(parseContextSize('auto'), undefined);
  assert.equal(parseContextSize('0'), undefined);
  assert.throws(() => parseContextSize('abc'));
  assert.throws(() => parseContextSize('500'));
  assert.equal(formatContextSize(128000), '128K');
  assert.equal(formatContextSize(1000000), '1M');
});

test('profile names and @profile arguments', () => {
  assert.equal(isValidProfileName('work_2-a'), true);
  assert.equal(isValidProfileName('has space'), false);
  assert.equal(isValidProfileName(''), false);
  assert.deepEqual(parseQuickArgs('codex', ['@work', 'sk-abc', 'm']), { tools: ['codex'], profile: 'work', apiKey: 'sk-abc', model: 'm' });
  assert.throws(() => parseQuickArgs('codex', ['@a', '@b']));
});

test('maskSecret keeps only the first and last 4 characters', () => {
  assert.equal(strip(maskSecret('sk-abcdefghijklmnop1234')), 'sk-a' + '•'.repeat(15) + '1234');
  assert.equal(maskSecret('short'), '•••••');
});

// ---- 像素 ----

test('every sprite is 12x10 and renders to 5 lines of 12 columns', () => {
  for (const id of Object.keys(SPRITES)) {
    const grid = spriteGrid(id);
    assert.equal(grid.length, 10, id);
    for (const row of grid) assert.equal(row.length, 12, id);
    const lines = renderGrid(grid);
    assert.equal(lines.length, 5);
    for (const line of lines) assert.equal(strip(line).length, 12, id);
  }
  assert.equal(logoGrid()[0].length, 32);
});

test('renderGrid maps pixel pairs to half blocks', async () => {
  const { default: chalk } = await import('chalk');
  chalk.level = 3;
  const lines = renderGrid([['#ff0000', undefined, '#00ff00', '#0000ff'], [undefined, '#ff0000', '#00ff00', '#ff0000']]);
  assert.equal(strip(lines[0]), '▀▄█▀');
  // 上下颜色不同：前景画上半格，背景画下半格（颜色级别随终端而定）
  assert.match(lines[0], /\x1B\[(?:48;[0-9;]+|10[0-7])m▀/);
  assert.deepEqual(joinBlocks([['ab'], ['x', 'y']], [3, 1], 1).map(strip), ['    x', 'ab  y']);
});

// ---- 配置档 ----

test('profiles: save, switch, pin a tool, remove', () => {
  configManager.clearConfig();
  configManager.saveProfile('work', 'sk-work', 'china');
  configManager.saveProfile('home', 'sk-home', 'custom', 'https://llm.example.com/');
  assert.equal(configManager.getActiveProfile(), undefined);

  configManager.useProfile('work');
  assert.equal(configManager.getActiveProfile(), 'work');
  assert.equal(configManager.getApiKey(), 'sk-work');

  // 修改当前 Key 时同步回当前配置档
  configManager.setApiKey('sk-work2');
  assert.equal(configManager.getProfile('work').apiKey, 'sk-work2');

  // 自定义地址：去掉末尾斜杠，并算作七牛线路
  assert.equal(configManager.getProfile('home').baseUrl, 'https://llm.example.com');
  assert.equal(isQiniuBaseUrl('https://llm.example.com/v1'), true);

  configManager.setToolProfile('codex', 'home');
  assert.deepEqual(configManager.getConnection('codex'), { apiKey: 'sk-home', endpoint: 'custom', baseUrl: 'https://llm.example.com', profile: 'home' });
  assert.equal(configManager.getConnection('grok').apiKey, 'sk-work2');
  // 绑定到当前配置档等于跟随
  configManager.setToolProfile('grok', 'work');
  assert.equal(configManager.getToolProfile('grok'), undefined);

  configManager.useProfile('home');
  assert.equal(configManager.getToolProfile('codex'), undefined, 'switching clears per-tool pins');
  assert.equal(configManager.baseUrl, 'https://llm.example.com');

  configManager.removeProfile('home');
  assert.equal(configManager.getActiveProfile(), undefined);
  assert.deepEqual(configManager.listProfiles().map((p) => p.name), ['work']);
});

test('context window is stored per tool and only for the tools given', () => {
  configManager.setContextWindow(64000, ['opencode', 'grok']);
  assert.equal(configManager.getContextWindow('opencode'), 64000);
  assert.equal(configManager.getContextWindow('grok'), 64000);
  assert.equal(configManager.getContextWindow('codex'), undefined, 'tools not selected are untouched');
  configManager.setContextWindow(undefined, ['grok']);
  assert.equal(configManager.getContextWindow('grok'), undefined);
  assert.equal(configManager.getContextWindow('opencode'), 64000);
});

test('settings snapshot restores models and context exactly', () => {
  configManager.setModels({ toolModels: { grok: 'a' }, codexModel: 'c1' });
  const snap = configManager.snapshotToolSettings();
  configManager.setModels({ toolModels: { opencode: 'b' }, codexModel: 'c2' });
  configManager.setContextWindow(32000, ['codex']);
  configManager.restoreToolSettings(snap);
  assert.deepEqual(configManager.getModels().toolModels, { grok: 'a' });
  assert.equal(configManager.getModels().codexModel, 'c1');
  assert.equal(configManager.getContextWindow('codex'), undefined);
});

test('Codex profiles: one provider per profile in config.toml, selection in qn-<name>.config.toml', () => {
  const existing = '[profiles.mine]\nmodel = "x"\n\n[model_providers.qnaigc-old]\nname = "stale"\n';
  const out = mergeCodexProfiles(existing, [{ name: 'work', apiKey: 'sk-w', baseUrl: 'https://api.qnaigc.com/' }]);
  assert.match(out, /\[profiles\.mine\]/, 'user profiles are kept');
  assert.doesNotMatch(out, /qnaigc-old/, 'stale profile providers are removed');
  assert.match(out, /\[model_providers\.qnaigc-work\]\nname = "Qiniu \(work\)"\nbase_url = "https:\/\/api\.qnaigc\.com\/bypass\/openai\/v1"\nexperimental_bearer_token = "sk-w"\nwire_api = "responses"/);
  assert.doesNotMatch(out, /\[profiles\.qn-work\]/, 'legacy profile tables break codex --profile on 0.134+');
  assert.equal(codexProfileName('my team'), 'qn-my-team');
  const file = buildCodexProfileFile('work', 'openai/gpt-6-astra', '/c.json');
  assert.match(file, /^model_provider = "qnaigc-work"$/m);
  assert.match(file, /^model = "openai\/gpt-6-astra"$/m);
});

// ---- 端到端：本地模拟七牛接口 ----

const MODELS = ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.2'];
const market = (id) => ({
  id, name: id, description: '', features: ['工具调用'],
  model_constraints: { context_length: 200000, max_tokens: 8192, max_completion_tokens: 0, max_default_completion_tokens: 0, max_chain_of_thought_length: 0 },
  architecture: { input_modalities: ['text'], output_modalities: ['text'], function_calling: { supported: true }, schema_output: { supported: false }, reasoning: { supported: false }, content_cache: { supported: false } },
  issuer: { name: '', avatar: '', model_page: '' },
});
const server = http.createServer((req, res) => {
  const [, region, ...rest] = req.url.split('?')[0].split('/');
  const route = `/${rest.join('/')}`;
  const key = (req.headers.authorization || '').replace('Bearer ', '');
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const ok = (region === 'cn' && key.startsWith('sk-cn')) || (region === 'intl' && key.startsWith('sk-intl'));
  if (!ok) return send(401, { error: { message: 'Invalid API key' } });
  if (route === '/v1/models') return send(200, { data: MODELS.map((id) => ({ id })) });
  if (route === '/v2/stat/usage') return send(200, { data: [] });
  if (route === '/v1/market/models') return send(200, { status: true, data: MODELS.map(market) });
  if (route === '/v1/chat/completions') return send(200, { choices: [{ message: { content: 'h' } }] });
  if (route === '/bypass/openai/v1/responses') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return res.end('data: {"type":"response.created"}\n\ndata: {"type":"response.completed"}\n\n');
  }
  send(404, {});
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function cli(home, args) {
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODING_HELPER_BASE_URL_CHINA: `${base}/cn`, CODING_HELPER_BASE_URL_INTERNATIONAL: `${base}/intl` };
  return new Promise((resolve) => {
    execFile(process.execPath, [path.resolve('dist/cli.js'), ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

test('profile commands, @profile in one command, --context, and restore', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-helper-e2e-'));
  assert.equal((await cli(home, ['profile', 'add', 'work', 'sk-cn-work'])).code, 0);
  assert.equal((await cli(home, ['profile', 'add', 'personal', 'sk-intl-me', '--intl'])).code, 0);

  // 一条命令：opencode 用当前配置档 work，上下文 64k
  let r = await cli(home, ['opencode', '--context', '64k', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const opencode = JSON.parse(fs.readFileSync(path.join(home, '.config/opencode/opencode.json'), 'utf8'));
  const provider = Object.values(opencode.provider)[0];
  assert.equal(provider.options.apiKey, 'sk-cn-work');
  assert.equal(Object.values(provider.models)[0].limit.context, 64000);

  // codex 绑定到 personal：走海外线路、用 personal 的 Key；其他工具不变
  r = await cli(home, ['codex', '@personal', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).profile, 'personal');
  const codexConfig = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
  assert.match(codexConfig, /\/intl\/bypass\/openai\/v1/);
  // --context 只作用于那条命令里的工具（opencode），Codex 不受影响
  assert.doesNotMatch(codexConfig, /model_context_window/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.codex/auth.json'), 'utf8')).OPENAI_API_KEY, 'sk-intl-me');
  assert.ok(fs.existsSync(path.join(home, '.codex/qn-work.config.toml')));
  assert.ok(fs.existsSync(path.join(home, '.codex/qn-personal.config.toml')));

  const list = JSON.parse((await cli(home, ['profile', 'list', '--json'])).stdout);
  assert.equal(list.active, 'work');
  assert.deepEqual(list.profiles.find((p) => p.name === 'personal').tools, ['codex']);
  assert.ok(list.profiles.every((p) => !p.apiKey.includes('work') || p.apiKey.includes('…')), 'keys are masked');

  // 非交互切换配置档：只切换，不改任何工具
  r = await cli(home, ['profile', 'use', 'personal']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const opencodeUnchanged = JSON.parse(fs.readFileSync(path.join(home, '.config/opencode/opencode.json'), 'utf8'));
  assert.equal(Object.values(opencodeUnchanged.provider)[0].options.apiKey, 'sk-cn-work');

  // --sync：已接入的工具改用当前配置档
  r = await cli(home, ['profile', 'use', 'personal', '--sync']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const opencodeAfter = JSON.parse(fs.readFileSync(path.join(home, '.config/opencode/opencode.json'), 'utf8'));
  assert.equal(Object.values(opencodeAfter.provider)[0].options.apiKey, 'sk-intl-me');

  // 不存在的配置档
  r = await cli(home, ['codex', '@nope']);
  assert.equal(r.code, 1);

  // 还原：Codex 的配置档文件与空的 config.toml 一并删除
  r = await cli(home, ['restore', '-y']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(home, '.codex')), false);
  assert.equal(fs.existsSync(path.join(home, '.config/opencode/opencode.json')), false);
});

test('findCommand finds tools outside PATH, e.g. Claude Code local install behind a shell alias', async (t) => {
  const { findCommand } = await import('../dist/utils/find-command.js');
  const { ClaudeCodeTool } = await import('../dist/lib/tools/claude-code-tool.js');
  const dir = path.join(os.homedir(), '.claude', 'local');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, '#!/bin/sh\necho "9.8.7 (Claude Code)"\n', { mode: 0o755 });
  const savedPath = process.env.PATH;
  // 隔离宿主机的全局安装，只让本用例创建的 Claude 可执行文件参与查找。
  const originalStatSync = fs.statSync;
  t.mock.method(fs, 'statSync', (candidate, ...args) => {
    if (path.basename(String(candidate)) === 'claude' && String(candidate) !== file) {
      throw Object.assign(new Error('Not present in test fixture'), { code: 'ENOENT' });
    }
    return originalStatSync(candidate, ...args);
  });
  process.env.PATH = '/nonexistent';
  try {
    assert.equal(findCommand('claude'), undefined);
    const tool = new ClaudeCodeTool();
    assert.equal(findCommand('claude', tool.searchPaths), file);
    if (process.platform !== 'win32') {
      assert.equal(tool.isInstalled(), true);
      assert.equal(tool.getVersion(), '9.8.7');
    }
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(path.join(os.homedir(), '.claude'), { recursive: true, force: true });
  }
});

test('Claude Code: switching models clears the /model selection and restore brings it back', async () => {
  const { ClaudeCodeTool } = await import('../dist/lib/tools/claude-code-tool.js');
  const { stateStore } = await import('../dist/lib/core/state-store.js');
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 用户原本在 /model 里选了 opus，环境里还有旧的 ANTHROPIC_MODEL
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', env: { ANTHROPIC_MODEL: 'old-model' } }, null, 2) + '\n');
  stateStore.markRemoved('claude-code');
  const tool = new ClaudeCodeTool();
  const slots = { haikuModel: 'z-ai/glm-5.2', sonnetModel: 'z-ai/glm-5.2', opusModel: 'z-ai/glm-5.2', subagentModel: 'z-ai/glm-5.2', useDefaultModels: false };
  await tool.loadConfig('sk-x', 'https://api.qnaigc.com', { claudeCode: slots });
  let settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(settings.model, undefined, '/model 回到 Default，跟随主模型');
  assert.equal(settings.env.ANTHROPIC_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'z-ai/glm-5.2');
  assert.equal(settings.env.ANTHROPIC_SMALL_FAST_MODEL, 'z-ai/glm-5.2');
  // /model 里的 Fable 项也指向七牛模型
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'z-ai/glm-5.2');

  // 接入后用户在 /model 里又选了 kimi，再次切换时同样被接管，且不会把 kimi 当作原值
  settings.model = 'moonshotai/kimi-k3';
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  await tool.loadConfig('sk-x', 'https://api.qnaigc.com', { claudeCode: slots });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model, undefined);

  tool.unloadConfig();
  settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(settings.model, 'opus');
  assert.equal(settings.env.ANTHROPIC_MODEL, 'old-model');
  fs.rmSync(path.join(os.homedir(), '.claude'), { recursive: true, force: true });
});
