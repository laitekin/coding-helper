import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 隔离 HOME；测试用假 Key，模型上限查询会失败并走默认值
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-helper-clients-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.XDG_CONFIG_HOME;
delete process.env.KIMI_CODE_HOME;
const BASE = 'http://127.0.0.1:9';
const MODELS = { defaultModel: 'deepseek-v3' };

const { OpenCodeTool, getOpenCodeConfigFile } = await import('../dist/lib/tools/opencode-tool.js');
const { QwenCodeTool } = await import('../dist/lib/tools/qwen-code-tool.js');
const { KimiCodeTool, getKimiConfigFile } = await import('../dist/lib/tools/kimi-code-tool.js');
const { DroidTool } = await import('../dist/lib/tools/droid-tool.js');
const { CopilotTool } = await import('../dist/lib/tools/copilot-tool.js');
const { stateStore } = await import('../dist/lib/core/state-store.js');
const { setDryRun, getPlannedChanges } = await import('../dist/lib/core/safe-write.js');
const { setDotenvValue, removeDotenvValue, getDotenvValue } = await import('../dist/lib/core/dotenv-edit.js');
const { removeTomlTablesWhere, upsertTopLevelTomlKey } = await import('../dist/lib/core/toml-edit.js');

// isConfigured 依据七牛域名判断，所以写入时使用七牛线路地址
const QINIU = 'https://api.qnaigc.com';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const read = (file) => fs.readFileSync(file, 'utf-8');
const json = (file) => JSON.parse(read(file));

test('OpenCode: adds the qiniu provider as default model, restore brings the old model back', async () => {
  stateStore.clear();
  const file = getOpenCodeConfigFile();
  const original = { model: 'anthropic/claude-sonnet', provider: { ollama: { npm: 'x' } }, theme: 'dark' };
  write(file, JSON.stringify(original));
  const tool = new OpenCodeTool();
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  const loaded = json(file);
  assert.equal(loaded.model, 'qiniu/deepseek-v3');
  assert.equal(loaded.provider.qiniu.options.baseURL, 'https://api.qnaigc.com/v1');
  assert.equal(loaded.provider.qiniu.options.apiKey, 'sk-qiniu');
  assert.ok(loaded.provider.ollama);
  assert.equal(tool.isConfigured(), true);

  tool.unloadConfig();
  assert.deepEqual(json(file), original);
});

test('OpenCode: a file that only existed because of us is removed on restore', async () => {
  stateStore.clear();
  fs.rmSync(path.join(home, '.config'), { recursive: true, force: true });
  const tool = new OpenCodeTool();
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  tool.unloadConfig();
  assert.equal(fs.existsSync(getOpenCodeConfigFile()), false);
});

test('Qwen Code: key goes to ~/.qwen/.env, settings reference it by envKey', async () => {
  stateStore.clear();
  const settingsFile = path.join(home, '.qwen', 'settings.json');
  const envFile = path.join(home, '.qwen', '.env');
  const original = {
    security: { auth: { selectedType: 'qwen-oauth' } },
    modelProviders: { openai: [{ id: 'gpt-4o', envKey: 'OPENAI_API_KEY' }] },
    ui: { theme: 'GitHub' },
  };
  write(settingsFile, JSON.stringify(original));
  write(envFile, '# mine\nOPENAI_API_KEY=sk-openai\n');

  const tool = new QwenCodeTool();
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  const loaded = json(settingsFile);
  assert.equal(loaded.security.auth.selectedType, 'openai');
  assert.equal(loaded.model.name, 'deepseek-v3');
  assert.equal(loaded.modelProviders.openai.length, 2);
  assert.equal(loaded.modelProviders.openai[1].envKey, 'QINIU_API_KEY');
  assert.doesNotMatch(read(settingsFile), /sk-qiniu/);
  assert.equal(getDotenvValue(read(envFile), 'QINIU_API_KEY'), 'sk-qiniu');
  assert.equal(tool.isConfigured(), true);

  tool.unloadConfig();
  assert.deepEqual(json(settingsFile), original);
  assert.equal(read(envFile), '# mine\nOPENAI_API_KEY=sk-openai\n');
});

test('Kimi Code CLI: provider and model alias tables, default_model restored byte for byte', async () => {
  stateStore.clear();
  const file = getKimiConfigFile();
  const original = [
    'default_model = "kimi-code/k3"',
    'telemetry = false',
    '',
    '[providers."managed:kimi-code"]',
    'type = "kimi"',
    '',
    '[models."kimi-code/k3"]',
    'provider = "managed:kimi-code"',
    'model = "k3"',
    '',
  ].join('\n');
  write(file, original);
  const tool = new KimiCodeTool();
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  const loaded = read(file);
  assert.match(loaded, /^default_model = "qiniu\/deepseek-v3"$/m);
  assert.match(loaded, /\[providers\.qiniu\]\ntype = "openai"\nbase_url = "https:\/\/api\.qnaigc\.com\/v1"\napi_key = "sk-qiniu"/);
  assert.match(loaded, /\[models\."qiniu\/deepseek-v3"\]\nprovider = "qiniu"\nmodel = "deepseek-v3"\nmax_context_size = 128000/);
  assert.match(loaded, /\[providers\."managed:kimi-code"\]/);

  // 重复装载保持幂等
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  assert.equal(read(file), loaded);

  tool.unloadConfig();
  assert.equal(read(file), original);
});

test('Factory Droid: only entries prefixed "Qiniu: " are added and removed', async () => {
  const file = path.join(home, '.factory', 'settings.json');
  const original = { customModels: [{ model: 'gpt-oss', displayName: 'Mine', baseUrl: 'https://x', provider: 'openai' }], diffMode: 'github' };
  write(file, JSON.stringify(original));
  const tool = new DroidTool();
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  const loaded = json(file);
  assert.equal(loaded.customModels.length, 2);
  assert.deepEqual(loaded.customModels[1], {
    model: 'deepseek-v3',
    displayName: 'Qiniu: deepseek-v3',
    baseUrl: 'https://api.qnaigc.com/v1',
    apiKey: 'sk-qiniu',
    provider: 'generic-chat-completion-api',
    maxOutputTokens: 8192,
    maxContextLimit: 128000,
  });
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  assert.equal(json(file).customModels.length, 2);
  tool.unloadConfig();
  assert.deepEqual(json(file), original);
});

test('Copilot CLI is launch-only and builds COPILOT_* variables', async () => {
  const tool = new CopilotTool();
  assert.equal(tool.launchOnly, true);
  assert.deepEqual(tool.getLaunchEnv('sk-qiniu', QINIU, MODELS), {
    COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_PROVIDER_BASE_URL: 'https://api.qnaigc.com/v1',
    COPILOT_PROVIDER_API_KEY: 'sk-qiniu',
    COPILOT_MODEL: 'deepseek-v3',
  });
  await assert.rejects(() => tool.loadConfig());
});

test('generic clients fail clearly when no model has been chosen', async () => {
  await assert.rejects(() => new DroidTool().loadConfig('sk', BASE, {}), /deepseek|model|模型/i);
});

test('dry run records changes without touching disk', async () => {
  stateStore.clear();
  const file = path.join(home, '.factory', 'settings.json');
  write(file, '{"diffMode":"github"}');
  setDryRun(true);
  await new DroidTool().loadConfig('sk-qiniu', QINIU, MODELS);
  const changes = getPlannedChanges();
  setDryRun(false);
  assert.equal(read(file), '{"diffMode":"github"}');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].file, file);
  assert.match(changes[0].after, /Qiniu: deepseek-v3/);
});

test('dotenv and toml helpers edit only the targeted lines', () => {
  assert.equal(setDotenvValue('A=1\n', 'B', '2'), 'A=1\nB=2\n');
  assert.equal(setDotenvValue('A=1\nB=0\n', 'B', '2'), 'A=1\nB=2\n');
  assert.equal(removeDotenvValue('A=1\nexport B=2\n', 'B'), 'A=1\n');
  assert.equal(
    removeTomlTablesWhere('[a]\nx = 1\n\n[models."qiniu/m"]\ny = 2\n[b]\n', (n) => n.startsWith('models."qiniu/')),
    '[a]\nx = 1\n\n[b]\n',
  );
  assert.equal(upsertTopLevelTomlKey('[a]\nx = 1\n', 'k', '"v"'), 'k = "v"\n\n[a]\nx = 1\n');
});
