import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 隔离 HOME；测试用假 Key，模型上限查询会失败并走默认值
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-helper-opencode-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.XDG_CONFIG_HOME;
const MODELS = { defaultModel: 'deepseek-v3' };
// isConfigured 依据七牛域名判断，所以写入时使用七牛线路地址；上限查询走不到真实服务时用默认值
const QINIU = 'https://api.qnaigc.com';

const { OpenCodeTool, getOpenCodeConfigFile } = await import('../dist/lib/tools/opencode-tool.js');
const { stateStore } = await import('../dist/lib/core/state-store.js');
const { marketModelService } = await import('../dist/lib/market-model-service.js');

// 不访问网络：模型上限查询直接失败，走默认值
marketModelService.fetchModels = async () => {
  throw new Error('offline');
};

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));

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

test('OpenCode: a later load records the values the user had at that time', async () => {
  stateStore.clear();
  const file = getOpenCodeConfigFile();
  write(file, JSON.stringify({ model: 'a/one' }));
  const tool = new OpenCodeTool();
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  tool.unloadConfig();
  // 卸载后用户自己换了模型，再次装载、卸载应还原成新的模型
  write(file, JSON.stringify({ model: 'b/two' }));
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  tool.unloadConfig();
  assert.equal(json(file).model, 'b/two');
});

test('OpenCode: a corrupt config is reported and never overwritten', async () => {
  stateStore.clear();
  const file = getOpenCodeConfigFile();
  write(file, '{ "model": ');
  await assert.rejects(() => new OpenCodeTool().loadConfig('sk-qiniu', QINIU, MODELS));
  assert.equal(fs.readFileSync(file, 'utf-8'), '{ "model": ');
});

test('OpenCode: fails clearly when no model has been chosen', async () => {
  await assert.rejects(() => new OpenCodeTool().loadConfig('sk', QINIU, {}), /model|模型/i);
});
