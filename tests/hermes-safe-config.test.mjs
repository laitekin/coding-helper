import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-safe-'));process.env.HOME=process.env.USERPROFILE=home;
const {HermesTool}=await import('../dist/lib/tools/hermes-tool.js');const tool=new HermesTool();const file=path.join(home,'.hermes/config.yaml');
test('Hermes roundtrip preserves comments and rejects corrupt or externally edited configuration',async()=>{fs.mkdirSync(path.dirname(file));const original='# keep\nmodel: {default: old, provider: original}\nother: true\n';fs.writeFileSync(file,original);await tool.loadConfig('key','https://api.qnaigc.com',{hermesModel:'test/model'});await tool.unloadConfig();assert.equal(fs.readFileSync(file,'utf8'),original);fs.writeFileSync(file,'model: [');await assert.rejects(tool.loadConfig('key','https://api.qnaigc.com',{hermesModel:'test/model'}));assert.equal(fs.readFileSync(file,'utf8'),'model: [');fs.writeFileSync(file,original);await tool.loadConfig('key','https://api.qnaigc.com',{hermesModel:'test/model'});fs.appendFileSync(file,'# user edit\n');await assert.rejects(tool.unloadConfig(),/changed/);assert.match(fs.readFileSync(file,'utf8'),/# user edit/);});

test('Hermes refuses to report successful unloading without restoration state',async()=>{
  const {stateStore}=await import('../dist/lib/core/state-store.js');stateStore.clear();const original='model: {api_key: legacy-key}\n';fs.writeFileSync(file,original);
  await assert.rejects(tool.unloadConfig(),/No restoration record/);assert.equal(fs.readFileSync(file,'utf8'),original);
});
test('Hermes tightens existing directory and unchanged file permissions',async()=>{
  if(process.platform==='win32')return;const {stateStore}=await import('../dist/lib/core/state-store.js');stateStore.clear();fs.writeFileSync(file,'{}');
  await tool.loadConfig('key','https://api.qnaigc.com',{hermesModel:'test/model'});
  fs.chmodSync(path.dirname(file),0o755);fs.chmodSync(file,0o644);await tool.loadConfig('key','https://api.qnaigc.com',{hermesModel:'test/model'});
  assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700);assert.equal(fs.statSync(file).mode&0o777,0o600);await tool.unloadConfig();
});
