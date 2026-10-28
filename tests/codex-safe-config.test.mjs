import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'codex-safe-'));process.env.HOME=process.env.USERPROFILE=home;
const {CodexTool}=await import('../dist/lib/tools/codex-tool.js');const tool=new CodexTool();const dir=path.join(home,'.codex');fs.mkdirSync(dir);const config=path.join(dir,'config.toml'),auth=path.join(dir,'auth.json');
test('Codex keeps MCP and original auth, restores exact bytes and rejects corrupt secondary JSON',async()=>{const original='# keep\nmodel = "old"\n[mcp_servers.demo]\ncommand = "node"\n';fs.writeFileSync(config,original);fs.writeFileSync(auth,'{ "OPENAI_API_KEY": null, "tokens": {"keep":1} }');await tool.loadConfig('key','https://api.qnaigc.com',{});assert.match(fs.readFileSync(config,'utf8'),/mcp_servers.demo/);assert.deepEqual(JSON.parse(fs.readFileSync(auth,'utf8')).tokens,{keep:1});await tool.unloadConfig();assert.equal(fs.readFileSync(config,'utf8'),original);assert.equal(fs.readFileSync(auth,'utf8'),'{ "OPENAI_API_KEY": null, "tokens": {"keep":1} }');fs.writeFileSync(auth,'{broken');await assert.rejects(tool.loadConfig('key','https://api.qnaigc.com',{}));assert.equal(fs.readFileSync(config,'utf8'),original);});

test('Codex deleted original blocks unload and keeps the restoration record',async()=>{
  const {stateStore}=await import('../dist/lib/core/state-store.js');stateStore.clear();fs.writeFileSync(config,'model = "original"\n');fs.writeFileSync(auth,'{}');
  await tool.loadConfig('key','https://api.qnaigc.com',{});const applied=fs.readFileSync(config,'utf8');const states=stateStore.getFileStates(tool.name);
  fs.rmSync(config);await assert.rejects(tool.unloadConfig(),/changed/);assert.deepEqual(stateStore.getFileStates(tool.name),states);
  fs.writeFileSync(config,applied);await tool.unloadConfig();assert.equal(fs.readFileSync(config,'utf8'),'model = "original"\n');
});
