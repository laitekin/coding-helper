import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 隔离 HOME：所有读写都落在临时目录
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-helper-apply-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { ClaudeCodeTool } = await import('../dist/lib/tools/claude-code-tool.js');
const { CodexTool } = await import('../dist/lib/tools/codex-tool.js');
const { stateStore } = await import('../dist/lib/core/state-store.js');
const { readJsonObjectStrict, safeWriteFile, getSessionBackups } = await import('../dist/lib/core/safe-write.js');

const settingsFile = path.join(home, '.claude', 'settings.json');
const claudeJsonFile = path.join(home, '.claude.json');
const codexConfig = path.join(home, '.codex', 'config.toml');
const codexAuth = path.join(home, '.codex', 'auth.json');

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function reset() {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  fs.rmSync(path.join(home, '.codex'), { recursive: true, force: true });
  fs.rmSync(claudeJsonFile, { force: true });
  stateStore.clear();
}

test('Claude Code: unload restores values the user had before', async () => {
  reset();
  const original = {
    model: 'opus',
    env: { ANTHROPIC_BASE_URL: 'https://corp.example', MY_VAR: '1' },
    companyAnnouncements: ['team note'],
  };
  writeFile(settingsFile, JSON.stringify(original, null, 2) + '\n');
  writeFile(claudeJsonFile, JSON.stringify({ hasCompletedOnboarding: false, theme: 'dark' }, null, 2) + '\n');

  const tool = new ClaudeCodeTool();
  await tool.loadConfig('sk-test-key', 'https://api.qnaigc.com', {});
  const loaded = readJsonObjectStrict(settingsFile);
  assert.equal(loaded.env.ANTHROPIC_BASE_URL, 'https://api.qnaigc.com');
  assert.equal(loaded.env.MY_VAR, '1');
  assert.equal(tool.isConfigured(), true);

  // 重复装载不应把七牛的值记成原值
  await tool.loadConfig('sk-test-key-2', 'https://api.modelink.ai', {});

  tool.unloadConfig();
  assert.deepEqual(readJsonObjectStrict(settingsFile), original);
  assert.deepEqual(readJsonObjectStrict(claudeJsonFile), { hasCompletedOnboarding: false, theme: 'dark' });
  assert.equal(tool.isConfigured(), false);
});

test('Claude Code: corrupt settings.json is never overwritten', async () => {
  reset();
  writeFile(settingsFile, '{ "env": { broken');
  const tool = new ClaudeCodeTool();
  await assert.rejects(() => tool.loadConfig('sk-test-key', 'https://api.qnaigc.com', {}), /Cannot parse/);
  assert.equal(fs.readFileSync(settingsFile, 'utf-8'), '{ "env": { broken');
});

test('Claude Code: unload leaves a config it did not write alone', () => {
  reset();
  const original = { env: { ANTHROPIC_BASE_URL: 'https://corp.example', ANTHROPIC_AUTH_TOKEN: 'corp' } };
  writeFile(settingsFile, JSON.stringify(original, null, 2) + '\n');
  new ClaudeCodeTool().unloadConfig();
  assert.deepEqual(readJsonObjectStrict(settingsFile), original);
});

test('Codex: load keeps MCP servers and unload restores the original file and auth', async () => {
  reset();
  const original = 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';
  writeFile(codexConfig, original);
  writeFile(codexAuth, JSON.stringify({ OPENAI_API_KEY: 'sk-openai', tokens: { a: 1 } }, null, 2) + '\n');

  const tool = new CodexTool();
  await tool.loadConfig('sk-qiniu', 'https://api.qnaigc.com', {});
  const loaded = fs.readFileSync(codexConfig, 'utf-8');
  assert.match(loaded, /\[mcp_servers\.docs\]/);
  assert.match(loaded, /\[model_providers\.qnaigc\]/);
  assert.equal(readJsonObjectStrict(codexAuth).OPENAI_API_KEY, 'sk-qiniu');
  assert.equal(readJsonObjectStrict(codexAuth).tokens.a, 1);

  await tool.unloadConfig();
  assert.equal(fs.readFileSync(codexConfig, 'utf-8'), original);
  assert.deepEqual(readJsonObjectStrict(codexAuth), { OPENAI_API_KEY: 'sk-openai', tokens: { a: 1 } });
  assert.equal(fs.existsSync(path.join(home, '.codex', 'model-catalogs', 'qnaigc.json')), false);
});

test('safeWriteFile backs up the original under ~/.coding-helper/backups', () => {
  const file = path.join(home, 'some-config.json');
  fs.writeFileSync(file, 'before\n');
  safeWriteFile(file, 'after\n');
  assert.equal(fs.readFileSync(file, 'utf-8'), 'after\n');
  const backup = getSessionBackups().find((entry) => entry.source === file);
  assert.ok(backup);
  assert.ok(backup.backup.startsWith(path.join(home, '.coding-helper', 'backups')));
  assert.equal(fs.readFileSync(backup.backup, 'utf-8'), 'before\n');
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(backup.backup), 'manifest.json'), 'utf-8'));
  assert.ok(manifest.files.some((entry) => entry.source === file));
});

test('stateStore keeps the first recorded prior values', () => {
  stateStore.clear();
  stateStore.recordPriors('demo', { a: 1 });
  stateStore.recordPriors('demo', { a: 2, b: 3 });
  assert.deepEqual(stateStore.getPriors('demo'), { a: 1, b: 3 });
  assert.equal(stateStore.isApplied('demo'), false);
  stateStore.markApplied('demo', 'china');
  assert.deepEqual(stateStore.getApplied(), ['demo']);
  stateStore.markRemoved('demo');
  assert.equal(stateStore.get('demo'), undefined);
});

test('sync skips a tool the user switched to another provider, restore still covers it', async () => {
  reset();
  const { getSyncTargets, getRestoreTargets } = await import('../dist/lib/core/tool-service.js');
  const tool = new ClaudeCodeTool();
  await tool.loadConfig('sk-test-key', 'https://api.qnaigc.com', {});
  stateStore.markApplied('claude-code', 'china');
  assert.ok(getSyncTargets().some((t) => t.name === 'claude-code'));

  const settings = readJsonObjectStrict(settingsFile);
  settings.env.ANTHROPIC_BASE_URL = 'https://other-provider.example';
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  assert.ok(!getSyncTargets().some((t) => t.name === 'claude-code'));
  assert.ok(getRestoreTargets().some((t) => t.name === 'claude-code'));
});
