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
  assert.equal(stateStore.getPriors('opencode', a).snapshot.model, 'a/model');
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
  assert.equal(stateStore.getPriors('opencode', file).snapshot.model, 'original');
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

test('OpenCode: unloading preserves managed fields subsequently changed by the user', async () => {
  const file = freshConfig('user-edits', { model: 'original/model' });
  const tool = new OpenCodeTool();
  await tool.loadConfig('fake', QINIU, MODELS);
  const edited = json(file);
  edited.model = 'user/new-model';
  edited.provider.qiniu = { name: 'replacement', options: { baseURL: 'https://other.example/v1' } };
  write(file, JSON.stringify(edited));
  tool.unloadConfig();
  const result = json(file);
  assert.equal(result.model, 'user/new-model');
  assert.deepEqual(result.provider.qiniu, edited.provider.qiniu);
});

test('OpenCode: unload without restoration state does not delete a user-owned Qiniu provider', () => {
  const original = { model: 'qiniu/user-model', provider: { qiniu: { options: { baseURL: QINIU }, models: { custom: {} } } } };
  const file = freshConfig('unmanaged-qiniu', original);
  new OpenCodeTool().unloadConfig();
  assert.deepEqual(json(file), original);
});

test('OpenCode: nested custom Qiniu settings survive a load/unload cycle', async () => {
  const original = { provider: { qiniu: { options: { baseURL: QINIU }, models: { custom: {} } } } };
  const file = freshConfig('nested-user-edits', original);
  const tool = new OpenCodeTool();
  await tool.loadConfig('fake', QINIU, MODELS);
  const edited = json(file);
  edited.provider.qiniu.options.timeout = 12345;
  write(file, JSON.stringify(edited));
  tool.unloadConfig();
  assert.equal(json(file).provider.qiniu.options.timeout, 12345);
});

test('OpenCode: corrupt state blocks unloading without touching the client file', async () => {
  const file = freshConfig('state-corruption', { model: 'original' });
  const tool = new OpenCodeTool();
  await tool.loadConfig('fake', QINIU, MODELS);
  const before = fs.readFileSync(file, 'utf8');
  const stateFile = path.join(home, '.coding-helper', 'state.json');
  const state = fs.readFileSync(stateFile, 'utf8');
  write(stateFile, '{broken');
  try { assert.throws(() => tool.unloadConfig(), /Cannot parse/); }
  finally { write(stateFile, state); }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('OpenCode: empty existing files and provider containers round trip', async () => {
  for (const [index, original] of [{}, { provider: {} }, { provider: { qiniu: {} } }, { model: 'x', provider: { qiniu: { models: { 'deepseek-v3': { custom: true } } } } }].entries()) {
    const file = freshConfig('roundtrip-' + index, original);
    const tool = new OpenCodeTool();
    await tool.loadConfig('fake', QINIU, MODELS);
    await tool.loadConfig('fake2', QINIU, { defaultModel: 'second-model' });
    tool.unloadConfig();
    tool.unloadConfig();
    assert.deepEqual(json(file), original);
  }
});

test('OpenCode: failed state cleanup can be retried without removing restored provider', async () => {
  const original = { model: 'original', provider: { qiniu: { options: { baseURL: QINIU }, custom: true } } };
  const file = freshConfig('cleanup-retry', original);
  const tool = new OpenCodeTool();
  await tool.loadConfig('fake', QINIU, MODELS);
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (String(target).endsWith('state.json')) throw new Error('state unavailable');
    return rename(source, target);
  };
  try { assert.throws(() => tool.unloadConfig(), /state unavailable/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(json(file), original);
  tool.unloadConfig();
  assert.deepEqual(json(file), original);
  assert.equal(stateStore.getState('opencode', file), undefined);
});

test('OpenCode: reloading after a managed field edit refuses stale restoration priors', async () => {
  const file = freshConfig('reload-after-edit', { model: 'original' });
  const tool = new OpenCodeTool();
  await tool.loadConfig('fake', QINIU, MODELS);
  const modified = json(file);
  modified.model = 'user/new-model';
  write(file, JSON.stringify(modified));
  await assert.rejects(tool.loadConfig('fake', QINIU, MODELS), /changed|unload/i);
  assert.equal(json(file).model, 'user/new-model');
});

test('OpenCode: invalid provider shapes are not normalized destructively', async () => {
  for (const original of [{ provider: [] }, { provider: 'broken' }, { enabled_providers: 'qiniu' }]) {
    const file = freshConfig('invalid-' + typeof original.provider, original);
    await assert.rejects(new OpenCodeTool().loadConfig('fake', QINIU, MODELS), /Invalid/);
    assert.deepEqual(json(file), original);
  }
});

test('OpenCode: symlinked directory aliases share restoration state', async () => {
  const file = freshConfig('real-xdg', { model: 'original' });
  const tool = new OpenCodeTool();
  await tool.loadConfig('fake', QINIU, MODELS);
  const alias = path.join(home, 'xdg-alias');
  fs.symlinkSync(path.join(home, 'real-xdg'), alias, 'dir');
  process.env.XDG_CONFIG_HOME = alias;
  tool.unloadConfig();
  assert.equal(json(file).model, 'original');
});

test('OpenCode: overlapping loads cannot record each other as original configuration', async () => {
  const file = freshConfig('overlapping-loads', { model: 'original' });
  const fetch = marketModelService.fetchModels;
  let release;
  marketModelService.fetchModels = () => new Promise(resolve => { release = resolve; });
  const tool = new OpenCodeTool();
  const first = tool.loadConfig('fake', QINIU, MODELS);
  marketModelService.fetchModels = async () => [];
  try {
    await tool.loadConfig('fake', QINIU, { defaultModel: 'second' });
    release([]);
    await assert.rejects(first, /changed/);
    tool.unloadConfig();
    assert.equal(json(file).model, 'original');
  } finally { marketModelService.fetchModels = fetch; }
});

test('OpenCode: external edit at final write rolls back its pending restoration record', async () => {
  const file = freshConfig('last-write-race', { model: 'original' });
  const copy = fs.copyFileSync;
  fs.copyFileSync = (source, ...args) => {
    const result = copy(source, ...args);
    if (source === file) write(file, '{"model":"editor","mcp":{"new":{}}}');
    return result;
  };
  try { await assert.rejects(new OpenCodeTool().loadConfig('fake', QINIU, MODELS), /changed before writing/); }
  finally { fs.copyFileSync = copy; }
  assert.deepEqual(json(file), { model: 'editor', mcp: { new: {} } });
  assert.equal(stateStore.getState('opencode', file), undefined);
});

test('OpenCode: dangling higher-precedence JSONC is rejected instead of writing JSON', async () => {
  const file = freshConfig('dangling-jsonc', { model: 'original' });
  fs.symlinkSync(path.join(home, 'absent-jsonc-target'), file + 'c');
  await assert.rejects(new OpenCodeTool().loadConfig('fake', QINIU, MODELS), /symbolic link/);
  assert.equal(json(file).model, 'original');
});

test('OpenCode: three-way restoration preserves an independent edit across varied originals', async () => {
  for (let i = 0; i < 25; i++) {
    const original = {
      ...(i % 2 ? { model: 'original-' + i } : {}),
      ...(i % 3 ? { $schema: 'https://opencode.ai/config.json' } : {}),
      provider: { other: { name: 'keep' }, ...(i % 4 ? { qiniu: { options: { timeout: i }, models: { existing: { name: 'keep' } } } } : {}) },
      mcp: { custom: { enabled: false } },
    };
    const file = freshConfig('matrix-' + i, original);
    const tool = new OpenCodeTool();
    await tool.loadConfig('fake', QINIU, MODELS);
    const changed = json(file);
    changed.permission = { edit: 'ask' };
    write(file, JSON.stringify(changed));
    tool.unloadConfig();
    assert.deepEqual(json(file), { ...original, permission: { edit: 'ask' } });
  }
});

test('OpenCode: the parsed object and guarded text come from the same read', async () => {
  const file = freshConfig('read-snapshot-race', { model: 'original' });
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (target, ...args) => {
    const result = read(target, ...args);
    if (String(target) === file && ++reads === 3) write(file, '{"model":"edited","permission":{"edit":"deny"}}');
    return result;
  };
  try { await assert.rejects(new OpenCodeTool().loadConfig('fake', QINIU, MODELS), /changed/); }
  finally { fs.readFileSync = read; }
  assert.deepEqual(json(file), { model: 'edited', permission: { edit: 'deny' } });
});

test('OpenCode: unload does not overwrite an edit between parsing and snapshot capture', async () => {
  const file = freshConfig('unload-read-race', { model: 'original' });
  const tool = new OpenCodeTool();
  await tool.loadConfig('fake', QINIU, MODELS);
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (target, ...args) => {
    const result = read(target, ...args);
    if (String(target) === file && ++reads === 1) write(file, '{"model":"edited","permission":{"edit":"deny"}}');
    return result;
  };
  try { assert.throws(() => tool.unloadConfig(), /changed/); }
  finally { fs.readFileSync = read; }
  assert.deepEqual(json(file), { model: 'edited', permission: { edit: 'deny' } });
});
