import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isolateHome } from './helpers/isolated-home.mjs';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'buddy-catalog-'));isolateHome(home);
const {CodeBuddyTool}=await import('../dist/lib/tools/codebuddy-tool.js');
const {WorkBuddyTool}=await import('../dist/lib/tools/workbuddy-tool.js');
const {marketModelService}=await import('../dist/lib/market-model-service.js');
const {modelService}=await import('../dist/lib/model-service.js');
const {previewWrites}=await import('../dist/lib/core/safe-write.js');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
for (const [Tool,dir,field] of [[CodeBuddyTool,'.codebuddy','codeBuddyModels'],[WorkBuddyTool,'.workbuddy','workbuddyModels']]) {
 for (const offline of [false,true]) test(`${Tool.name} ${offline?'manual':'standard catalog'} recovery previews, writes and restores`,async t=>{
  t.mock.method(marketModelService,'fetchModels',async()=>{throw Error('unavailable');});
  t.mock.method(modelService,'fetchModels',async()=>{if(offline)throw Error('unavailable');return[{id:'vendor/a'},{id:'vendor/b'}];});
  const tool=new Tool();const file=path.join(home,dir,'models.json');const models={[field]:['vendor/a','vendor/b']};
  const preview=await previewWrites(()=>tool.loadConfig('fixture','https://api.qnaigc.com',models));
  assert.ok(preview.changes.length, JSON.stringify({preview,config:tool.getConfig()}));assert.equal(fs.existsSync(file),false);
  await tool.loadConfig('fixture','https://api.qnaigc.com',models);
  const document=JSON.parse(fs.readFileSync(file,'utf8'));const written=Array.isArray(document)?document:document.models;
  assert.deepEqual(written.map(m=>m.id),models[field]);
  for(const m of written){assert.equal(m.supportsImages,false);assert.equal(m.supportsToolCall,true);assert.equal(m.maxInputTokens,200000);assert.equal(m.maxOutputTokens,8192);}
  await tool.unloadConfig();assert.equal(fs.existsSync(file),false);
 });
}
