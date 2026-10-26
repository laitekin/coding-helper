import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 隔离 HOME：配置文件、原值记录都落在临时目录（需在导入前设置）
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-helper-compat-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const {
  OpenAICompatTool,
  openAIBaseUrl,
  getPath,
  setPath,
  restorePath,
} = await import('../dist/lib/tools/openai-compat-tool.js');
const { isQiniuBaseUrl } = await import('../dist/lib/endpoints.js');
const { configManager } = await import('../dist/lib/config.js');
const { stateStore } = await import('../dist/lib/core/state-store.js');

// 最小的子类，只用来测试基类的公共逻辑
class DemoTool extends OpenAICompatTool {
  name = 'demo';
  displayName = 'Demo';
  command = 'demo-cli-not-installed';
  installCommand = 'npm install -g demo';
  getConfig() { return {}; }
  isConfigured() { return false; }
  async loadConfig(_apiKey, _baseUrl, models) { this.model = this.resolveModel(models); }
  unloadConfig() {}
}

test('resolveModel prefers the per-tool model, then the default model', async () => {
  const tool = new DemoTool();
  await tool.loadConfig('sk', 'https://api.qnaigc.com', { toolModels: { demo: 'a' }, defaultModel: 'b' });
  assert.equal(tool.model, 'a');
  await tool.loadConfig('sk', 'https://api.qnaigc.com', { toolModels: { other: 'a' }, defaultModel: 'b' });
  assert.equal(tool.model, 'b');
  await assert.rejects(() => tool.loadConfig('sk', 'https://api.qnaigc.com', {}), /Demo/);
});

test('a missing command is reported as not installed', () => {
  const tool = new DemoTool();
  assert.equal(tool.isInstalled(), false);
  assert.equal(tool.getVersion(), null);
});

test('openAIBaseUrl appends /v1 once', () => {
  assert.equal(openAIBaseUrl('https://api.qnaigc.com'), 'https://api.qnaigc.com/v1');
  assert.equal(openAIBaseUrl('https://api.qnaigc.com/'), 'https://api.qnaigc.com/v1');
});

test('path helpers write nested values and restore removes what was added', () => {
  const config = { keep: 1 };
  setPath(config, 'provider.qiniu.options.baseURL', 'https://api.qnaigc.com/v1');
  assert.equal(getPath(config, 'provider.qiniu.options.baseURL'), 'https://api.qnaigc.com/v1');
  // 原值为 null：删除，并清理因此变空的中间对象
  restorePath(config, 'provider.qiniu.options.baseURL', null);
  assert.deepEqual(config, { keep: 1 });
  // 原值存在：写回原值
  setPath(config, 'model', 'qiniu/x');
  restorePath(config, 'model', 'old/model');
  assert.equal(config.model, 'old/model');
});

test('isQiniuBaseUrl recognises both endpoints and the legacy domain', () => {
  assert.equal(isQiniuBaseUrl('https://api.qnaigc.com/v1'), true);
  assert.equal(isQiniuBaseUrl('https://api.modelink.ai/'), true);
  assert.equal(isQiniuBaseUrl('https://openai.qiniu.com/v1'), true);
  assert.equal(isQiniuBaseUrl('https://api.openai.com/v1'), false);
  assert.equal(isQiniuBaseUrl(undefined), false);
});

test('toolModels are merged per tool and defaultModel is kept', () => {
  configManager.setModels({ toolModels: { a: 'm1' }, defaultModel: 'm1' });
  configManager.setModels({ toolModels: { b: 'm2' } });
  const models = configManager.getModels();
  assert.deepEqual(models.toolModels, { a: 'm1', b: 'm2' });
  assert.equal(models.defaultModel, 'm1');
});

test('clearing the config keeps backups and recorded prior values', () => {
  configManager.setApiKey('sk-test');
  stateStore.recordPriors('demo', { model: 'old' });
  fs.mkdirSync(path.join(home, '.coding-helper', 'backups'), { recursive: true });
  configManager.clearConfig();
  assert.equal(fs.existsSync(path.join(home, '.coding-helper', 'config.yaml')), false);
  assert.equal(fs.existsSync(path.join(home, '.coding-helper', 'backups')), true);
  assert.deepEqual(stateStore.getPriors('demo'), { model: 'old' });
});
