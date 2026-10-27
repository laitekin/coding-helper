import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {findCommand,commandVersion} from '../dist/utils/find-command.js';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'find-command-'));process.env.HOME=process.env.USERPROFILE=home;
test('findCommand prefers PATH and falls back to home installs and explicit aliases',()=>{const old=process.env.PATH;const first=path.join(home,'path');const second=path.join(home,'.local/bin');fs.mkdirSync(first);fs.mkdirSync(second,{recursive:true});const name='helper-probe-unique';for(const dir of [first,second])fs.writeFileSync(path.join(dir,name),'#!/bin/sh\nexit 0\n',{mode:0o700});process.env.PATH=first;try{assert.equal(findCommand(name),path.join(first,name));process.env.PATH='';assert.equal(findCommand(name),path.join(second,name));const extra=path.join(home,'extra');fs.writeFileSync(extra,'#!/bin/sh\nexit 0\n',{mode:0o700});assert.equal(findCommand('missing-probe-unique',[extra]),extra);assert.equal(findCommand('$(touch unexpected)'),undefined);fs.chmodSync(extra,0o600);if(process.platform!=='win32')assert.equal(findCommand('missing-probe-unique',[extra]),undefined);}finally{process.env.PATH=old;}});
test('version check treats shell metacharacters in executable path literally',{skip:process.platform==='win32'},()=>{const file=path.join(home,'version $(echo not-executed)');fs.writeFileSync(file,'#!/bin/sh\nprintf "probe 1.2.3\\n"\n',{mode:0o700});assert.equal(commandVersion(file),'1.2.3');});
