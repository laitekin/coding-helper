import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-openclaw-')));
process.env.HOME = process.env.USERPROFILE = home;
for (const key of ['OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_PROFILE', 'OPENCLAW_HOME']) delete process.env[key];
delete process.env.KIMI_CODE_HOME; delete process.env.GROK_HOME;
const { OpenClawTool, getOpenClawConfigFile } = await import('../dist/lib/tools/openclaw-tool.js');
const { marketModelService } = await import('../dist/lib/market-model-service.js');
const { toolManager } = await import('../dist/lib/tool-manager.js');
const { hasSavedToolModelConfig } = await import('../dist/lib/wizard/menus/tool-menu.js');
const tool = new OpenClawTool(); tool.getVersion = () => null;
marketModelService.fetchModels = async () => [];
const files = [".openclaw/openclaw.json"].map(file => path.join(home, file));
const originals = ["{ \"agents\": {\"defaults\":{\"model\":{\"primary\":\"original\"}}}, \"custom\":true }"];
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const read = file => fs.readFileSync(file, 'utf8');
const load = (key = 'test-key') => tool.loadConfig(key, 'https://api.qnaigc.com', { toolModels: { [tool.name]: 'test/model' } });
test('openclaw is registered and recognizes saved generic model selection', () => {
  assert.ok(toolManager.get(tool.name));
  assert.equal(hasSavedToolModelConfig(tool, { toolModels: { [tool.name]: 'test/model' } }), true);
});
test('openclaw restores bytes and refuses corrupt or changed config', async () => {
  files.forEach((file, i) => write(file, originals[i]));
  await load(); await load('second-key');
  assert.equal(JSON.parse(read(files[0])).agents.defaults.model.primary, 'qiniu/test/model');
  await tool.unloadConfig(); files.forEach((file, i) => assert.equal(read(file), originals[i]));
  write(files[0], "{ // comment\n\"custom\":true }");
  await assert.rejects(load()); assert.equal(read(files[0]), "{ // comment\n\"custom\":true }");
  write(files[0], originals[0]); await load();
  const applied = read(files[0]); write(files[0], applied + ' ');
  await assert.rejects(load(), /changed/); assert.throws(() => tool.unloadConfig(), /changed/);
  assert.equal(read(files[0]), applied + ' '); write(files[0], applied);
  await tool.unloadConfig();
  files.forEach(file => fs.rmSync(file));
  await load(); await tool.unloadConfig(); files.forEach(file => assert.equal(fs.existsSync(file), false));
});


test('OpenClaw respects explicit paths and never silently edits the default for a profile', async () => {
  const keys = ['OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_PROFILE', 'OPENCLAW_HOME'];
  try {
    process.env.OPENCLAW_STATE_DIR = '~/alternate';
    assert.equal(getOpenClawConfigFile(), path.join(home, 'alternate/openclaw.json'));
    process.env.OPENCLAW_CONFIG_PATH = '~/custom/settings.json';
    const file = getOpenClawConfigFile(); assert.equal(file, path.join(home, 'custom/settings.json'));
    write(file, '{}'); await load(); await tool.unloadConfig(); assert.equal(read(file), '{}');
    delete process.env.OPENCLAW_CONFIG_PATH; delete process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_PROFILE = 'work'; assert.throws(() => getOpenClawConfigFile(), /named OpenClaw profile/);
    delete process.env.OPENCLAW_PROFILE; process.env.OPENCLAW_HOME = path.join(home, 'other-home');
    assert.equal(getOpenClawConfigFile(), path.join(home, 'other-home/.openclaw/openclaw.json'));
  } finally { for (const key of keys) delete process.env[key]; }
});

test('OpenClaw expands home override tilde against real user home before dependent paths',async()=>{
 const keys=['OPENCLAW_HOME','OPENCLAW_STATE_DIR','OPENCLAW_CONFIG_PATH'];
 try{
  for(const value of ['~','~/custom-home']){
   process.env.OPENCLAW_HOME=value;const effective=value==='~'?home:path.join(home,'custom-home');const expected=path.join(effective,'.openclaw/openclaw.json');assert.equal(getOpenClawConfigFile(),expected);
   write(expected,'{"original":true}');await load();assert.equal(JSON.parse(read(expected)).agents.defaults.model.primary,'qiniu/test/model');await tool.unloadConfig();assert.equal(read(expected),'{"original":true}');
   process.env.OPENCLAW_STATE_DIR='~/state';assert.equal(getOpenClawConfigFile(),path.join(effective,'state/openclaw.json'));
   process.env.OPENCLAW_CONFIG_PATH='~/chosen.json';assert.equal(getOpenClawConfigFile(),path.join(effective,'chosen.json'));delete process.env.OPENCLAW_STATE_DIR;delete process.env.OPENCLAW_CONFIG_PATH;
  }
 }finally{for(const key of keys)delete process.env[key];}
});
