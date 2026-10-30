import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import test from 'node:test';
import { isolateHome } from './helpers/isolated-home.mjs'; import { runPrompt } from './helpers/prompt-pty.mjs';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'write-plan-'));isolateHome(home);
const {configManager}=await import('../dist/lib/config.js');
const {safeWriteFile}=await import('../dist/lib/core/safe-write.js');
const {previewWritePlan,commitWritePlan}=await import('../dist/lib/wizard/ui/write-plan.js');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
const file=path.join(home,'client/settings.json');
const tool={name:'demo',displayName:'Demo',supportsPreview:true,checkModel:async model=>model==='bad'?'incompatible':undefined,loadConfig:async(key,url,models)=>safeWriteFile(file,JSON.stringify({key,url,model:models.toolModels.demo}))};
const item={tool,main:'good',models:{toolModels:{demo:'good'}},changes:[],connection:{apiKey:'sk-captured',endpoint:'custom',baseUrl:'https://captured.example'}};
test('write-plan preview and rejected validation leave every real file unchanged',async()=>{
 const preview=await previewWritePlan([item]);assert.equal(preview.value[0].status,'success');assert.equal(preview.changes.length,1);assert.deepEqual(fs.readdirSync(home),[]);
 const results=await commitWritePlan([{...item,main:'bad'}]);assert.equal(results[0].status,'failed');assert.deepEqual(fs.readdirSync(home),[]);
});
test('write plan uses captured connection and persists only successful settings',async()=>{
 configManager.saveProfile('active','sk-current','china');configManager.useProfile('active');
 const results=await commitWritePlan([item,{...item,tool:{...tool,name:'failed',loadConfig:async()=>{throw Error('credential secret');}}}]);
 assert.deepEqual(results.map(r=>r.status),['success','failed']);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).key,'sk-captured');
 assert.equal(configManager.getApiKey(),'sk-current');assert.equal(configManager.getActiveProfile(),'active');assert.equal(configManager.getModels().toolModels.demo,'good');assert.equal(configManager.getModels().toolModels.failed,undefined);
});
test('real PTY confirmation cancel leaves helper and clients untouched', {skip:process.platform==='win32'},async()=>{
 const out=await runPrompt(`import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {configManager} from './dist/lib/config.js';import {safeWriteFile} from './dist/lib/core/safe-write.js';import {confirmAndWrite} from './dist/lib/wizard/ui/write-plan.js';const file=path.join(os.homedir(),'client.json');const tool={name:'demo',displayName:'Demo',supportsPreview:true,loadConfig:async()=>safeWriteFile(file,'{"key":"sk-secret"}')};console.log('RESULT',await confirmAndWrite('CONFIRM_READY',[{tool,changes:[],connection:{apiKey:'sk-secret',endpoint:'china',baseUrl:'https://example.com'}}]));console.log('CLIENT',fs.existsSync(file));console.log('SAVED',fs.existsSync(configManager.configFile));`,[['CONFIRM_READY','\x1b']]);assert.match(out,/RESULT.*back/);assert.match(out,/CLIENT.*false/);assert.match(out,/SAVED.*false/);assert.equal(out.includes('sk-secret'),false);
});
