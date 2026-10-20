import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-helper-clients-more-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.GROK_HOME;
delete process.env.MINIMAX_DATA_DIR;
delete process.env.MAVIS_DATA_DIR;
const QINIU = 'https://api.qnaigc.com';
const MODELS = { defaultModel: 'deepseek-v3' };

const { GrokTool, getGrokConfigFile } = await import('../dist/lib/tools/grok-tool.js');
const { OpenClawTool, getOpenClawConfigFile } = await import('../dist/lib/tools/openclaw-tool.js');
const { MinimaxCodeTool, getMinimaxConfigFile, removeMinimaxProvider } = await import('../dist/lib/tools/minimax-code-tool.js');
const { stateStore } = await import('../dist/lib/core/state-store.js');
const { upsertTomlTableKey, removeTomlTableKey, getTomlTableValue } = await import('../dist/lib/core/toml-edit.js');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const read = (file) => fs.readFileSync(file, 'utf-8');

test('Grok CLI: [model.qiniu] plus [models] default, restored byte for byte', async () => {
  stateStore.clear();
  const file = getGrokConfigFile();
  const original = '# my grok\n[models]\ndefault = "grok-build"\n\n[mcp_servers.docs]\ncommand = "docs"\n';
  write(file, original);
  const tool = new GrokTool();
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  const loaded = read(file);
  assert.equal(getTomlTableValue(loaded, 'models', 'default'), '"qiniu"');
  assert.match(loaded, /\[model\.qiniu\]\nmodel = "deepseek-v3"\nname = "Qiniu: deepseek-v3"\nbase_url = "https:\/\/api\.qnaigc\.com\/v1"\napi_key = "sk-qiniu"\napi_backend = "chat_completions"/);
  assert.match(loaded, /\[mcp_servers\.docs\]/);
  assert.equal(tool.isConfigured(), true);
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  assert.equal(read(file), loaded);
  tool.unloadConfig();
  assert.equal(read(file), original);
});

test('Grok CLI: a [models] table created by us is removed again', async () => {
  stateStore.clear();
  const file = getGrokConfigFile();
  const original = '[mcp_servers.docs]\ncommand = "docs"\n';
  write(file, original);
  const tool = new GrokTool();
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  tool.unloadConfig();
  assert.equal(read(file), original);
});

test('OpenClaw: provider + primary model, allowlist updated only when present', async () => {
  stateStore.clear();
  const file = getOpenClawConfigFile();
  const original = {
    agents: { defaults: { workspace: '~/work', model: { primary: 'anthropic/claude-sonnet' }, models: { 'anthropic/claude-sonnet': {} } } },
    models: { mode: 'merge', providers: { other: { baseUrl: 'https://x' } } },
  };
  write(file, JSON.stringify(original, null, 2));
  const tool = new OpenClawTool();
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  const loaded = JSON.parse(read(file));
  assert.equal(loaded.agents.defaults.model.primary, 'qiniu/deepseek-v3');
  assert.deepEqual(loaded.agents.defaults.models['qiniu/deepseek-v3'], {});
  assert.equal(loaded.models.providers.qiniu.api, 'openai-completions');
  assert.equal(loaded.models.providers.qiniu.baseUrl, 'https://api.qnaigc.com/v1');
  assert.ok(loaded.models.providers.other);
  assert.equal(tool.isConfigured(), true);
  tool.unloadConfig();
  assert.deepEqual(JSON.parse(read(file)), original);
});

test('OpenClaw: JSON5 config with comments is reported, never overwritten', async () => {
  stateStore.clear();
  const file = getOpenClawConfigFile();
  const json5 = '{\n  // my comment\n  agents: { defaults: { workspace: "~/w" } },\n}\n';
  write(file, json5);
  await assert.rejects(() => new OpenClawTool().loadConfig('sk', QINIU, MODELS), /JSON5/);
  assert.equal(read(file), json5);
});

test('MiniMax Code: setup calls mcode provider add, restore removes custom_provider.qiniu', async () => {
  // 假的 mcode：把参数和环境变量里的 Key 写成 config.yaml，模拟真实 CLI 的行为
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'mcode'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path'); const yaml = require(${JSON.stringify(require_js_yaml())});
const args = process.argv.slice(2); const get = (f) => args[args.indexOf(f) + 1];
const file = path.join(process.env.HOME, '.minimax', 'config.yaml');
const cfg = fs.existsSync(file) ? yaml.load(fs.readFileSync(file, 'utf8')) || {} : {};
cfg.custom_provider = cfg.custom_provider || {};
cfg.custom_provider[get('--name')] = { api: get('--api-format'), options: { apiKey: process.env[get('--api-key-env')], baseURL: get('--base-url') }, models: { [get('--model')]: {} } };
fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, yaml.dump(cfg));
`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

  const file = getMinimaxConfigFile();
  write(file, yaml.dump({ theme: 'dark', custom_provider: { relay: { options: { baseURL: 'https://relay' } } } }));
  const tool = new MinimaxCodeTool();
  await tool.loadConfig('sk-qiniu', QINIU, MODELS);
  const loaded = yaml.load(read(file));
  assert.equal(loaded.custom_provider.qiniu.options.apiKey, 'sk-qiniu');
  assert.equal(loaded.custom_provider.qiniu.options.baseURL, 'https://api.qnaigc.com/v1');
  assert.equal(loaded.custom_provider.qiniu.api, 'openai-completions');
  assert.equal(tool.isConfigured(), true);

  tool.unloadConfig();
  assert.deepEqual(yaml.load(read(file)), { theme: 'dark', custom_provider: { relay: { options: { baseURL: 'https://relay' } } } });
  assert.equal(removeMinimaxProvider(''), '');
});

test('toml table key helpers', () => {
  assert.equal(upsertTomlTableKey('a = 1\n', 'models', 'default', '"x"'), 'a = 1\n\n[models]\ndefault = "x"\n');
  assert.equal(upsertTomlTableKey('[models]\nfoo = 1\n\n[b]\n', 'models', 'default', '"x"'), '[models]\nfoo = 1\ndefault = "x"\n\n[b]\n');
  assert.equal(removeTomlTableKey('[models]\ndefault = "x"\n[b]\n', 'models', 'default'), '[b]\n');
  assert.equal(removeTomlTableKey('[models]\nfoo = 1\ndefault = "x"\n', 'models', 'default'), '[models]\nfoo = 1\n');
});

function require_js_yaml() {
  return path.join(process.cwd(), 'node_modules', 'js-yaml');
}
