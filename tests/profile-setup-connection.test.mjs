import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import test from 'node:test'; import {isolateHome} from './helpers/isolated-home.mjs';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'profile-setup-connection-'));isolateHome(home);
const {configManager}=await import('../dist/lib/config.js');const {toolManager}=await import('../dist/lib/tool-manager.js');const {setupCommand}=await import('../dist/commands/setup.js');
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
test('setup validates and writes each pinned connection without sending its key to the global endpoint',async()=>{
 const targets=[['private-a','sk-private-a','https://a.example/root'],['private-b','sk-private-b','https://b.example/proxy']];const writes=[],requests=[];
 for(const [name,key,baseUrl] of targets){configManager.saveProfile(name,key,'custom',baseUrl);configManager.setToolProfile(name,name);toolManager.register({name,displayName:name,loadConfig:async(apiKey,url)=>writes.push([name,apiKey,url])});}
 assert.equal(configManager.getApiKey(),undefined);
 const originalFetch=globalThis.fetch,originalLog=console.log,originalExit=process.exitCode;let output='';
 globalThis.fetch=async(url,options)=>{requests.push([String(url),options.headers.Authorization]);return new Response(JSON.stringify(String(url).endsWith('/v1/models')?{data:[{id:'probe/model'}]}:{choices:[]}));};
 console.log=value=>{output+=value;};
 try {await setupCommand({tools:targets.map(t=>t[0]).join(','),json:true});assert.equal(process.exitCode,0);}
 finally{globalThis.fetch=originalFetch;console.log=originalLog;process.exitCode=originalExit;}
 assert.deepEqual(writes,targets);
 assert.ok(requests.length>=4);
 for(const [url,authorization] of requests){const target=targets.find(t=>url.startsWith(t[2]+'/'));assert.ok(target,'Unexpected endpoint: '+url);assert.equal(authorization,'Bearer '+target[1]);}
 for(const [,key] of targets)assert.equal(output.includes(key),false);
});
