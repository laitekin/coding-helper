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

function freshConfig(name, original = {}) {
  process.env.XDG_CONFIG_HOME = path.join(home, name);
  stateStore.clear();
  const file = getOpenCodeConfigFile();
  write(file, JSON.stringify(original));
  return file;
}

test('OpenCode: restores an unrelated model and an existing qiniu provider', async () => {
  const original = { model: 'anthropic/claude-sonnet', provider: { qiniu: { name: 'original', options: { baseURL: QINIU } } } };
  const file = freshConfig('existing-provider', original);
  const tool = new OpenCodeTool();
  await tool.loadConfig('fake', QINIU, MODELS);
  tool.unloadConfig();
  assert.deepEqual(json(file), original);
});

test('OpenCode: refuses concurrent edits or corrupt JSON after metadata fetch', async () => {
  const originalFetch = marketModelService.fetchModels;
  try {
    for (const changed of ['{"permission":{"edit":"deny"},"mcp":{"local":{}}}', '{broken', '']) {
      const file = freshConfig('race-' + changed.length, { model: 'before' });
      marketModelService.fetchModels = async () => { write(file, changed); return []; };
      await assert.rejects(new OpenCodeTool().loadConfig('fake', QINIU, MODELS), /changed|Cannot parse/);
      assert.equal(fs.readFileSync(file, 'utf8'), changed);
      assert.equal(stateStore.getPriors('opencode', file), undefined);
    }
  } finally { marketModelService.fetchModels = originalFetch; }
});

test('OpenCode: distinct XDG paths retain separate restoration state', async () => {
  const a = freshConfig('xdg-a', { model: 'a/model' });
  const tool = new OpenCodeTool();
  await tool.loadConfig('fake', QINIU, MODELS);
  process.env.XDG_CONFIG_HOME = path.join(home, 'xdg-b');
  const b = getOpenCodeConfigFile();
  write(b, JSON.stringify({ model: 'b/model' }));
  await tool.loadConfig('fake', QINIU, MODELS);
  tool.unloadConfig();
  assert.equal(json(b).model, 'b/model');
  assert.equal(stateStore.getPriors('opencode', a).model, 'a/model');
  process.env.XDG_CONFIG_HOME = path.join(home, 'xdg-a');
  tool.unloadConfig();
  assert.equal(json(a).model, 'a/model');
});

test('OpenCode: failed backup or rename discards only new priors and retry records fresh model', async () => {
  for (const operation of ['copyFileSync', 'renameSync']) {
    const file = freshConfig('failure-' + operation, { model: 'before' });
    const originalOperation = fs[operation];
    fs[operation] = (...args) => {
      if (args[0] === file || args[1] === file) throw new Error('injected failure');
      return originalOperation(...args);
    };
    const tool = new OpenCodeTool();
    try { await assert.rejects(tool.loadConfig('fake', QINIU, MODELS), /injected/); }
    finally { fs[operation] = originalOperation; }
    assert.equal(json(file).model, 'before');
    assert.equal(stateStore.getPriors('opencode', file), undefined);
    write(file, JSON.stringify({ model: 'after-failure' }));
    await tool.loadConfig('fake', QINIU, MODELS);
    tool.unloadConfig();
    assert.equal(json(file).model, 'after-failure');
  }
});

test('OpenCode: failed repeated load preserves priors from successful application', async () => {
  const file = freshConfig('repeat-failure', { model: 'original' });
  const tool = new OpenCodeTool();
  await tool.loadConfig('fake', QINIU, MODELS);
  const original = fs.renameSync;
  fs.renameSync = (...args) => { if (args[1] === file) throw new Error('write failure'); return original(...args); };
  try { await assert.rejects(tool.loadConfig('fake', QINIU, { defaultModel: 'different' }), /write failure/); }
  finally { fs.renameSync = original; }
  assert.equal(stateStore.getPriors('opencode', file).model, 'original');
  tool.unloadConfig();
  assert.equal(json(file).model, 'original');
});

test('OpenCode: symlink targets and links remain unchanged', async () => {
  const file = freshConfig('symlink');
  const target = path.join(home, 'dotfiles-opencode.json');
  write(target, '{"model":"original"}');
  fs.rmSync(file);
  fs.symlinkSync(target, file);
  const tool = new OpenCodeTool();
  await assert.rejects(tool.loadConfig('fake', QINIU, MODELS), /symbolic link/);
  assert.throws(() => tool.unloadConfig(), /symbolic link/);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"model":"original"}');
  assert.equal(stateStore.getPriors('opencode', file), undefined);
});

test('OpenCode: JSONC takes precedence and restores the same file', async () => {
  const file = freshConfig('jsonc', { model: 'json/model' });
  const jsonc = file + 'c';
  const original = '{"model":"jsonc/model"}';
  write(jsonc, original);
  assert.equal(getOpenCodeConfigFile(), jsonc);
  const tool = new OpenCodeTool();
  await tool.loadConfig('fake', QINIU, MODELS);
  assert.equal(json(jsonc).model, 'qiniu/deepseek-v3');
  assert.equal(json(file).model, 'json/model');
  tool.unloadConfig();
  assert.equal(fs.readFileSync(jsonc, 'utf8'), original);
  write(jsonc, '{ // comment\n "model": "unchanged" }');
  await assert.rejects(tool.loadConfig('fake', QINIU, MODELS), /Cannot parse/);
  assert.equal(json(file).model, 'json/model');
});

test('OpenCode: provider filter conflicts fail before changes or prior recording', async () => {
  for (const filters of [{ enabled_providers: ['anthropic'] }, { disabled_providers: ['qiniu'] }]) {
    for (const withJsonc of [false, true]) {
      const file = freshConfig('filters-' + Object.keys(filters)[0] + withJsonc, { model: 'original', ...filters });
      if (withJsonc) write(file + 'c', '{}');
      const target = getOpenCodeConfigFile();
      const before = fs.readFileSync(target, 'utf8');
      await assert.rejects(new OpenCodeTool().loadConfig('fake', QINIU, MODELS), /filters exclude/);
      assert.equal(fs.readFileSync(target, 'utf8'), before);
      assert.equal(stateStore.getPriors('opencode', target), undefined);
    }
  }
});

test('OpenCode: generated vision models retain input modalities', async () => {
  const file = freshConfig('vision');
  const original = marketModelService.fetchModels;
  marketModelService.fetchModels = async () => [{ id: 'vision', features: [], model_constraints: { context_length: 32000, max_tokens: 4096 }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'], function_calling: { supported: true }, reasoning: { supported: false } } }];
  try {
    await new OpenCodeTool().loadConfig('fake', QINIU, { defaultModel: 'vision' });
    assert.deepEqual(json(file).provider.qiniu.models.vision.modalities, { input: ['text', 'image'], output: ['text'] });
  } finally { marketModelService.fetchModels = original; }
});
