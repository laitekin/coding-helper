import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'transaction-'))); process.env.HOME=process.env.USERPROFILE=home;
const {applyConfigEdits,restoreConfigEdits,parseConfigObject}=await import('../dist/lib/core/config-transaction.js');
const {stateStore}=await import('../dist/lib/core/state-store.js');
let id=0;
function pair(){const dir=path.join(home,String(++id)); fs.mkdirSync(dir);return ['a','b'].map(n=>path.join(dir,n));}
const edit=(files)=>files.map((file,i)=>({file,build:()=>String(i)}));
test('multi-file apply reload and byte exact restore',()=>{const f=pair();fs.writeFileSync(f[0],' \r\n');applyConfigEdits('demo',edit(f));applyConfigEdits('demo',edit(f));restoreConfigEdits('demo',f);assert.equal(fs.readFileSync(f[0],'utf8'),' \r\n');assert.equal(fs.existsSync(f[1]),false);assert.equal(stateStore.getState('demo',f[0]),undefined);});
test('all builders validate before writing',()=>{const f=pair();fs.writeFileSync(f[0],'original');assert.throws(()=>applyConfigEdits('demo',[{file:f[0],build:()=> 'new'},{file:f[1],build:()=>{throw Error('invalid');}}]),/invalid/);assert.equal(fs.readFileSync(f[0],'utf8'),'original');assert.equal(stateStore.getState('demo',f[0]),undefined);});
test('second write failure rolls back file and state',()=>{const f=pair();fs.writeFileSync(f[0],'old');const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b===f[1])throw Error('failed');return rename(a,b);};try{assert.throws(()=>applyConfigEdits('demo',edit(f)),/failed/);}finally{fs.renameSync=rename;}assert.equal(fs.readFileSync(f[0],'utf8'),'old');assert.equal(stateStore.getState('demo',f[0]),undefined);});
test('external edits block reload and restore with state retained',()=>{const f=pair();applyConfigEdits('demo',edit(f));fs.writeFileSync(f[1],'user');assert.throws(()=>applyConfigEdits('demo',edit(f)),/changed/);assert.throws(()=>restoreConfigEdits('demo',f),/changed/);assert.equal(fs.readFileSync(f[0],'utf8'),'0');assert.equal(fs.readFileSync(f[1],'utf8'),'user');assert.ok(stateStore.getState('demo',f[0]));});
test('unmanaged files, symbolic links and malformed state are protected',()=>{const f=pair();fs.writeFileSync(f[0],'user');restoreConfigEdits('demo',f);assert.equal(fs.readFileSync(f[0],'utf8'),'user');fs.symlinkSync(f[0],f[1]);assert.throws(()=>applyConfigEdits('demo',edit(f)),/symbolic/);stateStore.setState('demo',{priors:{}},f[0]);assert.throws(()=>restoreConfigEdits('demo',f),/Invalid/);});
test('restore retry after state cleanup failure',()=>{const f=pair();fs.writeFileSync(f[0],'old');applyConfigEdits('demo',edit(f));const remove=stateStore.markRemoved;stateStore.markRemoved=()=>{throw Error('cleanup');};try{assert.throws(()=>restoreConfigEdits('demo',f),/cleanup/);}finally{stateStore.markRemoved=remove;}restoreConfigEdits('demo',f);assert.equal(fs.readFileSync(f[0],'utf8'),'old');assert.equal(fs.existsSync(f[1]),false);});
test('strict object parser rejects existing empty and non-object JSON',()=>{assert.deepEqual(parseConfigObject(undefined),{});for(const value of ['', 'null','[]','{broken'])assert.throws(()=>parseConfigObject(value));});
