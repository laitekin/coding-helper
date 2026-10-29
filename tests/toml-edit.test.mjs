import assert from 'node:assert/strict';
import test from 'node:test';
import {parse} from 'smol-toml';
import * as toml from '../dist/lib/core/toml-edit.js';
test('CRLF survives insertion of missing root keys, table keys and tables', () => {
  const source = '# keep\r\n[existing]\r\nx = 1\r\n';
  const root = toml.upsertTopLevelTomlKey(source, 'model', '"new"');
  assert.equal(root, '# keep\r\nmodel = "new"\r\n\r\n[existing]\r\nx = 1\r\n');
  const table = toml.upsertTomlTableKey(source, 'existing', 'other', 'true');
  assert.equal(table, '# keep\r\n[existing]\r\nx = 1\r\nother = true\r\n');
  const added = toml.upsertTomlTableKey(source, 'new', 'key', '2');
  assert.equal(added, '# keep\r\n[existing]\r\nx = 1\r\n\r\n[new]\r\nkey = 2\r\n');
  for (const result of [root, table, added, toml.normalizeToml(source)]) {
    assert.doesNotMatch(result, /(?<!\r)\n/);
    assert.equal(parse(result).existing.x, 1);
  }
});
test('TOML edits preserve unrelated comments and nested MCP configuration',()=>{const s='# keep\nmodel = "old"\n\n[mcp_servers.demo]\ncommand = "node" # keep\n';const n=toml.upsertTopLevelTomlKey(s,'model','"new"');assert.equal(parse(n).model,'new');assert.ok(n.endsWith('[mcp_servers.demo]\ncommand = "node" # keep\n'));});
test('table helpers edit and remove only requested table keys',()=>{const s='[models]\ndefault = "old"\nkeep = true\n[other]\nx = 1\n';const n=toml.upsertTomlTableKey(s,'models','default','"qiniu"');assert.equal(parse(n).models.default,'qiniu');assert.equal(parse(toml.removeTomlTableKey(n,'models','default')).models.keep,true);assert.deepEqual(parse(toml.removeTomlTable(n,'models')),{other:{x:1}});});
test('special characters in strings cannot inject TOML',()=>{const value='x"\nnew = "bad\t\\';const s=toml.upsertTopLevelTomlKey('','model','"'+toml.escapeTomlString(value)+'"');assert.equal(parse(s).model,value);});
test('invalid, duplicate and unsupported multiline values fail closed',()=>{for(const s of ['x = ', 'x=1\nx=2', 'x='+String.fromCharCode(34).repeat(3)+'\n[a]\n'+String.fromCharCode(34).repeat(3)])assert.throws(()=>toml.upsertTopLevelTomlKey(s,'model','"new"'));});
test('inline comments and CRLF are retained when replacing managed keys',()=>{const before='  model  = "old#value"  # keep\r\n[other]\r\nx=1\r\n';const after=toml.upsertTopLevelTomlKey(before,'model','"new"');assert.equal(after,'  model  = "new"  # keep\r\n[other]\r\nx=1\r\n');});
test('special headers and multiline arrays cannot cause a later table to be removed',()=>{const text='[managed]\nx=1\n["other]table"]\nkeep=true\n';assert.throws(()=>toml.removeTomlTable(text,'managed'),/Unsupported/);assert.throws(()=>toml.removeTomlTable('array = [\n  [1,2],\n]\n[managed]\nx=1\n','managed'));});


test('quoted and spaced table names resolve to the same semantic path', () => {
  const source = '["models"]\ndefault = "old"\n[model . "qiniu"]\nmodel = "old"\n["model.qiniu"]\nkeep = true\n';
  const changed = toml.upsertTomlTableKey(source, 'models', 'default', '"new"');
  assert.equal(parse(changed).models.default, 'new');
  const removed = toml.removeTomlTable(changed, 'model.qiniu');
  assert.equal(parse(removed).model, undefined);
  assert.equal(parse(removed)['model.qiniu'].keep, true);
  assert.equal(toml.tomlTableName('[models."qiniu/x"]'), 'models."qiniu/x"');
});
