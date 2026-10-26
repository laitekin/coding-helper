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
const { readJsonConfig, writeJsonConfig } = await import('../dist/lib/core/json-config.js');
const { toQiniuModel, mergeQiniuModels } = await import('../dist/lib/tools/models-json.js');
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

test('shared JSON reader rejects corrupt, empty and non-object files', () => {
  for (const content of ['broken', '', 'null', '[]', '42']) {
    seed(content);
    assert.throws(() => readJsonConfig(file));
    assert.throws(() => writeJsonConfig(file, { replacement: true }));
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
  fs.rmSync(file);
  assert.deepEqual(readJsonConfig(file), {});
});

test('writer preserves formatting, backs up the original and uses private permissions', () => {
  const original = '{\r\n\t"mine": true\r\n}\r\n';
  seed(original);
  writeJsonConfig(file, { mine: true, added: 1 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\r\n\t"mine": true,\r\n\t"added": 1\r\n}\r\n');
  const backups = path.join(home, '.coding-helper', 'backups');
  assert.ok(fs.readdirSync(backups).some(name => fs.readFileSync(path.join(backups, name), 'utf8') === original));
  const count = fs.readdirSync(backups).length;
  writeJsonConfig(file, { mine: true, added: 1 });
  assert.equal(fs.readdirSync(backups).length, count);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    for (const name of fs.readdirSync(backups)) assert.equal(fs.statSync(path.join(backups, name)).mode & 0o777, 0o600);
  }
});

test('rename failure keeps the original and cleans up the temporary file', t => {
  seed('{"mine":true}');
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('rename failed'); });
  assert.throws(() => writeJsonConfig(file, { added: true }), /rename failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mine":true}');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['models.json']);
  rename.mock.restore();
});

test('backup failure prevents config replacement', t => {
  seed('{"mine":true}');
  const write = fs.writeFileSync;
  const mocked = t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    if (String(target).endsWith('.bak')) throw new Error('backup failed');
    return write(target, ...args);
  });
  assert.throws(() => writeJsonConfig(file, { added: true }), /backup failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mine":true}');
  mocked.mock.restore();
});

test('symlink is preserved and dangling links are not replaced', { skip: process.platform === 'win32' }, () => {
  const target = path.join(home, 'target.json');
  const link = path.join(home, 'link.json');
  fs.writeFileSync(target, '{}');
  fs.symlinkSync(target, link);
  writeJsonConfig(link, { added: true });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.deepEqual(readJsonConfig(target), { added: true });
  fs.rmSync(target);
  assert.throws(() => writeJsonConfig(link, { added: false }));
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('model mapping and deduplication preserve existing provider precedence', () => {
  const mapped = toQiniuModel(market, 'test-key', 'https://example.test/');
  assert.equal(mapped.url, 'https://example.test/v1/chat/completions');
  assert.equal(mapped.maxInputTokens, 64000);
  assert.equal(mapped.maxOutputTokens, 4096);
  assert.equal(mapped.supportsToolCall, true);
  assert.equal(mapped.supportsImages, true);
  const original = { custom: { keep: true }, models: [{ id: 'sample', vendor: 'Mine' }, { id: 'old', vendor: 'Qiniu' }] };
  const snapshot = structuredClone(original);
  const next = mergeQiniuModels(original, [mapped, mapped]);
  assert.deepEqual(next.models, [{ id: 'sample', vendor: 'Mine' }]);
  assert.deepEqual(next.availableModels, ['sample']);
  assert.deepEqual(next.custom, original.custom);
  assert.deepEqual(original, snapshot);
});

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


test('unload preserves duplicate entries owned by other vendors', () => {
  const mine = { id: 'same', vendor: 'Mine' };
  const other = { id: 'same', vendor: 'Other' };
  const next = mergeQiniuModels({ models: [mine, other, { id: 'qiniu', vendor: 'Qiniu' }] }, []);
  assert.deepEqual(next.models, [mine, other]);
  assert.deepEqual(next.availableModels, ['same', 'same']);
});
