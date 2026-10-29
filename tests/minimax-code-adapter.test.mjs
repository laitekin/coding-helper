import spawn from 'cross-spawn';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'minimax-'));process.env.HOME=process.env.USERPROFILE=home;delete process.env.MINIMAX_DATA_DIR;delete process.env.MAVIS_DATA_DIR;
const {MinimaxCodeTool,getMinimaxConfigFile}=await import('../dist/lib/tools/minimax-code-tool.js');const {marketModelService}=await import('../dist/lib/market-model-service.js');marketModelService.fetchModels=async()=>[];
test('MiniMax stages official provider writes and restores original; failures never alter user config or echo key',async()=>{const file=getMinimaxConfigFile();fs.mkdirSync(path.dirname(file),{recursive:true});const original='# keep\ndefaultModel: original\n';fs.writeFileSync(file,original);const exec=spawn.sync;const tool=new MinimaxCodeTool();let stage;
spawn.sync=(command,args,options)=>{assert.equal(path.basename(command),'mcode');assert.deepEqual(args.slice(0,2),['provider','add']);assert.equal(args.includes('secret-key'),false);assert.equal(options.env.QINIU_API_KEY,'secret-key');stage=options.env.MINIMAX_DATA_DIR;assert.doesNotMatch(fs.readFileSync(path.join(stage,'config.yaml'),'utf8'), /qiniu:/);assert.notEqual(stage,path.dirname(file));assert.equal(options.env.MAVIS_DATA_DIR,stage);fs.writeFileSync(path.join(stage,'config.yaml'),'custom_provider:\n  qiniu: {api: openai-completions, options: {baseURL: "https://api.qnaigc.com/v1", apiKey: secret-key}, models: {"test/model": {}}}\ndefaultModel: custom_provider:qiniu/test/model\n');return {status:0,stdout:'',stderr:''};};syncBuiltinESMExports();
try{await tool.loadConfig('secret-key','https://api.qnaigc.com',{defaultModel:'test/model'});assert.equal(fs.existsSync(stage),false);await tool.loadConfig('secret-key','https://api.qnaigc.com',{defaultModel:'test/model'});tool.unloadConfig();assert.equal(fs.readFileSync(file,'utf8'),original);spawn.sync=()=>{throw Error('secret-key');};syncBuiltinESMExports();await assert.rejects(tool.loadConfig('secret-key','https://api.qnaigc.com',{defaultModel:'test/model'}),error=>!error.message.includes('secret-key'));assert.equal(fs.readFileSync(file,'utf8'),original);}finally{spawn.sync=exec;syncBuiltinESMExports();}});


test('MiniMax success exit without matching staged provider never overwrites user configuration', async () => {
  const file = getMinimaxConfigFile(); const original = fs.readFileSync(file, 'utf8');
  const exec = spawn.sync;
  spawn.sync = (_command, _args, options) => {
    fs.writeFileSync(path.join(options.env.MINIMAX_DATA_DIR, 'config.yaml'), 'custom_provider: {qiniu: {options: {baseURL: wrong}}}\ndefaultModel: custom_provider:qiniu/test/model\n'); return {status:0,stdout:'',stderr:''};
  }; syncBuiltinESMExports();
  try { await assert.rejects(new MinimaxCodeTool().loadConfig('secret-key', 'https://api.qnaigc.com', {defaultModel:'test/model'}), /does not match/); }
  finally { spawn.sync = exec; syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('MiniMax unload without a restoration record preserves legacy credentials and reports recovery guidance', () => {
  const file=getMinimaxConfigFile(); const tool=new MinimaxCodeTool();
  fs.rmSync(file,{force:true}); assert.doesNotThrow(()=>tool.unloadConfig());
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'legacy credential bytes');
  assert.throws(()=>tool.unloadConfig(),/No restoration record.*Configuration is unchanged.*manually/);
  assert.equal(fs.readFileSync(file,'utf8'),'legacy credential bytes');
});

test('MiniMax shows progress before slow metadata and provider work without exposing credentials', async () => {
  const {logger}=await import('../dist/utils/logger.js');const {i18n}=await import('../dist/lib/i18n.js');i18n.init('en_US');
  const info=logger.info,fetch=marketModelService.fetchModels,exec=spawn.sync;const messages=[];logger.info=message=>messages.push(message);
  const file=getMinimaxConfigFile();fs.rmSync(file,{force:true});
  marketModelService.fetchModels=async()=>{assert.ok(messages.some(m=>m.includes('model limits')));return [];};
  spawn.sync=(_file,_args,options)=>{assert.ok(messages.some(m=>m.includes('90 seconds')));fs.writeFileSync(path.join(options.env.MINIMAX_DATA_DIR,'config.yaml'),'custom_provider:\n  qiniu: {api: openai-completions, options: {baseURL: "https://api.qnaigc.com/v1", apiKey: secret-key}, models: {"test/model": {}}}\ndefaultModel: custom_provider:qiniu/test/model\n');return {status:0};};syncBuiltinESMExports();
  try {const tool=new MinimaxCodeTool();await tool.loadConfig('secret-key','https://api.qnaigc.com',{defaultModel:'test/model'});assert.ok(messages.some(m=>m.includes('Validating')));assert.ok(messages.some(m=>m.includes('configuration applied')));assert.ok(messages.every(m=>!m.includes('secret-key')));tool.unloadConfig();}
  finally{logger.info=info;marketModelService.fetchModels=fetch;spawn.sync=exec;syncBuiltinESMExports();}
});
