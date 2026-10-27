import assert from 'node:assert/strict';
import test from 'node:test';
import {parse} from 'smol-toml';
import * as toml from '../dist/lib/core/toml-edit.js';
test('TOML edits preserve unrelated comments and nested MCP configuration',()=>{const s='# keep\nmodel = "old"\n\n[mcp_servers.demo]\ncommand = "node" # keep\n';const n=toml.upsertTopLevelTomlKey(s,'model','"new"');assert.equal(parse(n).model,'new');assert.ok(n.endsWith('[mcp_servers.demo]\ncommand = "node" # keep\n'));});
test('table helpers edit and remove only requested table keys',()=>{const s='[models]\ndefault = "old"\nkeep = true\n[other]\nx = 1\n';const n=toml.upsertTomlTableKey(s,'models','default','"qiniu"');assert.equal(parse(n).models.default,'qiniu');assert.equal(parse(toml.removeTomlTableKey(n,'models','default')).models.keep,true);assert.deepEqual(parse(toml.removeTomlTable(n,'models')),{other:{x:1}});});
test('special characters in strings cannot inject TOML',()=>{const value='x"\nnew = "bad\t\\';const s=toml.upsertTopLevelTomlKey('','model','"'+toml.escapeTomlString(value)+'"');assert.equal(parse(s).model,value);});
test('invalid, duplicate and unsupported multiline values fail closed',()=>{for(const s of ['x = ', 'x=1\nx=2', 'x='+String.fromCharCode(34).repeat(3)+'\n[a]\n'+String.fromCharCode(34).repeat(3)])assert.throws(()=>toml.upsertTopLevelTomlKey(s,'model','"new"'));});
