import assert from 'node:assert/strict';
import test from 'node:test';
import {setDotenvValue} from '../dist/lib/core/dotenv-edit.js';
test('dotenv preserves unrelated lines and replaces one exported key',()=>{assert.equal(setDotenvValue('# keep\nOTHER=value\nexport QINIU_API_KEY=old\n','QINIU_API_KEY','new-key'),'# keep\nOTHER=value\nQINIU_API_KEY=new-key\n');});
test('dotenv rejects duplicate variables, multiline values and injected keys',()=>{for(const content of ['QINIU_API_KEY=a\nQINIU_API_KEY=b\n','QINIU_API_KEY="first\nsecond"\n'])assert.throws(()=>setDotenvValue(content,'QINIU_API_KEY','new'));for(const value of ['x\nOTHER=bad','x\rOTHER=bad','$(touch bad)'])assert.throws(()=>setDotenvValue('','QINIU_API_KEY',value));assert.throws(()=>setDotenvValue('','KEY\nBAD','value'));});
