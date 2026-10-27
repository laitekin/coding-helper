import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import childProcess from 'node:child_process';import {EventEmitter} from 'node:events';import {syncBuiltinESMExports} from 'node:module';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'run-test-'));process.env.HOME=process.env.USERPROFILE=home;
const {runCommand}=await import('../dist/commands/run.js');const {configManager}=await import('../dist/lib/config.js');const {toolManager}=await import('../dist/lib/tool-manager.js');const {createProgram}=await import('../dist/lib/command.js');
test('launcher passes literal args env and exit status; writes no client config and cleans signal listeners',async()=>{configManager.setApiKey('test-key');const base=process.listenerCount('SIGINT');const original=childProcess.spawn;const fake={name:'test-run',command:'fake',displayName:'Fake',installCommand:'install',isInstalled:()=>true,getLaunchEnv:(key)=>({TEST_KEY:key})};toolManager.register(fake);let observed;
childProcess.spawn=(file,args,options)=>{observed={file,args,options};const child=new EventEmitter();child.kill=()=>true;queueMicrotask(()=>child.emit('exit',7,null));return child;};syncBuiltinESMExports();try{await createProgram().parseAsync(['node','helper','run','test-run','--','--resume','$(echo literal)']);assert.deepEqual(observed.args,['--resume','$(echo literal)']);assert.equal(observed.options.shell,false);assert.equal(observed.options.env.TEST_KEY,'test-key');assert.equal(process.exitCode,7);assert.equal(process.listenerCount('SIGINT'),base);assert.deepEqual(fs.readdirSync(home),['.coding-helper']);}finally{childProcess.spawn=original;syncBuiltinESMExports();process.exitCode=0;}});
test('unsupported tool fails without launching a process',async()=>{await runCommand('unsupported',[]);assert.equal(process.exitCode,1);process.exitCode=0;});


test('run forwards client help and version flags without interpreting them as helper options', async () => {
  const original = childProcess.spawn; let observed;
  childProcess.spawn = (file, args) => { observed = args; const child = new EventEmitter(); child.kill = () => true; queueMicrotask(() => child.emit('exit', 0, null)); return child; };
  syncBuiltinESMExports();
  try {
    for (const flag of ['--help', '--version', '-h', '-V']) {
      await createProgram().exitOverride().parseAsync(['node', 'helper', 'run', 'test-run', flag]);
      assert.deepEqual(observed, [flag]);
    }
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); process.exitCode = 0; }
});

test('spawn errors and child termination clean listeners and preserve failure status', async () => {
  const original = childProcess.spawn; const count = process.listenerCount('SIGINT');
  try {
    for (const mode of ['error', 'signal']) {
      childProcess.spawn = () => { const child = new EventEmitter(); child.kill = () => true; queueMicrotask(() => mode === 'error' ? child.emit('error', Error('cannot start')) : child.emit('exit', null, 'SIGTERM')); return child; };
      syncBuiltinESMExports(); await runCommand('test-run', []);
      assert.equal(process.exitCode, mode === 'error' ? 1 : 143); assert.equal(process.listenerCount('SIGINT'), count);
    }
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); process.exitCode = 0; }
});
