import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-grok-')));
process.env.HOME = process.env.USERPROFILE = home;
delete process.env.KIMI_CODE_HOME; delete process.env.GROK_HOME;
const { GrokTool } = await import('../dist/lib/tools/grok-tool.js');
const { marketModelService } = await import('../dist/lib/market-model-service.js');
const { toolManager } = await import('../dist/lib/tool-manager.js');
const { hasSavedToolModelConfig } = await import('../dist/lib/wizard/menus/tool-menu.js');
const tool = new GrokTool(); tool.getVersion = () => null;
marketModelService.fetchModels = async () => [];
const files = [".grok/config.toml"].map(file => path.join(home, file));
const originals = ["# keep\n[models]\ndefault = \"original\"\n[other]\ncustom = true\n"];
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const read = file => fs.readFileSync(file, 'utf8');
const load = (key = 'test-key') => tool.loadConfig(key, 'https://api.qnaigc.com', { toolModels: { [tool.name]: 'test/model' } });
test('grok is registered and recognizes saved generic model selection', () => {
  assert.ok(toolManager.get(tool.name));
  assert.equal(hasSavedToolModelConfig(tool, { toolModels: { [tool.name]: 'test/model' } }), true);
});
test('grok restores bytes and refuses corrupt or changed config', async () => {
  files.forEach((file, i) => write(file, originals[i]));
  await load(); await load('second-key');
  assert.match(read(files[0]), /model.qiniu/); assert.equal(read(files[0]).includes('session_summary'), false);
  await tool.unloadConfig(); files.forEach((file, i) => assert.equal(read(file), originals[i]));
  write(files[0], "broken = [");
  await assert.rejects(load()); assert.equal(read(files[0]), "broken = [");
  write(files[0], originals[0]); await load();
  const applied = read(files[0]); write(files[0], applied + ' ');
  await assert.rejects(load(), /changed/); assert.throws(() => tool.unloadConfig(), /changed/);
  assert.equal(read(files[0]), applied + ' '); write(files[0], applied);
  await tool.unloadConfig();
  files.forEach(file => fs.rmSync(file));
  await load(); await tool.unloadConfig(); files.forEach(file => assert.equal(fs.existsSync(file), false));
});


test('Grok loads equivalent quoted TOML tables and restores original bytes', async () => {
  const original = '["models"]\ndefault = "old"\n[model."qiniu"]\nmodel = "old"\n';
  write(files[0], original); await load(); await load('second-key');
  await tool.unloadConfig(); assert.equal(read(files[0]), original);
});
