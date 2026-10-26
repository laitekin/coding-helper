import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-shared-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { CodeBuddyTool } = await import('../dist/lib/tools/codebuddy-tool.js');
const { marketModelService } = await import('../dist/lib/market-model-service.js');
const { readJsonConfig } = await import('../dist/lib/core/json-config.js');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const file = path.join(home, '.codebuddy', 'models.json');
const market = {
  id: 'sample', name: 'Sample', features: ['工具调用'],
  model_constraints: { context_length: 64000, max_tokens: 4096 },
  architecture: { function_calling: { supported: false }, input_modalities: ['image'], reasoning: { supported: false } },
};
function seed(text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('CodeBuddy load, reload and unload preserve unrelated user settings', async t => {
  t.mock.method(marketModelService, 'fetchModels', async () => [market]);
  seed(JSON.stringify({ custom: true, models: [{ id: 'mine', vendor: 'Mine' }] }));
  const tool = new CodeBuddyTool();
  await tool.loadConfig('test-key', 'https://example.test', { codeBuddyModels: ['sample'] });
  const first = fs.readFileSync(file, 'utf8');
  await tool.loadConfig('test-key', 'https://example.test', { codeBuddyModels: ['sample'] });
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  assert.deepEqual(readJsonConfig(file).availableModels, ['mine', 'sample']);
  await tool.unloadConfig();
  assert.deepEqual(readJsonConfig(file), { custom: true, models: [{ id: 'mine', vendor: 'Mine' }], availableModels: ['mine'] });
});

test('CodeBuddy refuses corrupt config or missing models without overwriting files', async t => {
  t.mock.method(marketModelService, 'fetchModels', async () => [market]);
  const tool = new CodeBuddyTool();
  seed('{broken');
  await assert.rejects(tool.loadConfig('test-key', 'https://example.test', { codeBuddyModels: ['sample'] }));
  await assert.rejects(tool.unloadConfig());
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  seed('{"keep":true}');
  await assert.rejects(tool.loadConfig('test-key', 'https://example.test', { codeBuddyModels: ['missing'] }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"keep":true}');
});
